const { join, sep, dirname } = require('path');
const {
  readFile, writeFile, pathExists, move,
} = require('fs-extra');

const glob = require('@now/build-utils/fs/glob.js'); // eslint-disable-line import/no-extraneous-dependencies
const download = require('@now/build-utils/fs/download.js'); // eslint-disable-line import/no-extraneous-dependencies
const { createLambda } = require('@now/build-utils/lambda.js'); // eslint-disable-line import/no-extraneous-dependencies
const getWritableDirectory = require('@now/build-utils/fs/get-writable-directory.js'); // eslint-disable-line import/no-extraneous-dependencies
const { createGo, getExportedFunctionName } = require('./go-helpers');

const config = {
  maxLambdaSize: '10mb',
};

async function gatherExtraFiles(globMatcher, entrypoint) {
  if (!globMatcher) return {};

  console.log('gathering extra files for the fs...');

  const entryDir = dirname(entrypoint);

  if (Array.isArray(globMatcher)) {
    const allMatches = await Promise.all(
      globMatcher.map(pattern => glob(pattern, entryDir)),
    );

    return allMatches.reduce((acc, matches) => ({ ...acc, ...matches }), {});
  }

  return glob(globMatcher, entryDir);
}

async function build({ files, entrypoint, config }) {
  console.log('Downloading user files...');

  const [goPath, outDir] = await Promise.all([
    getWritableDirectory(),
    getWritableDirectory(),
  ]);

  const srcPath = join(goPath, 'src', 'lambda');
  const downloadedFiles = await download(files, srcPath);

  console.log(`Parsing AST for "${entrypoint}"`);
  let parseFunctionName;
  try {
    parseFunctionName = await getExportedFunctionName(
      downloadedFiles[entrypoint].fsPath,
    );
  } catch (err) {
    console.log(`Failed to parse AST for "${entrypoint}"`);
    throw err;
  }

  if (!parseFunctionName) {
    const err = new Error(
      `Could not find an exported function in "${entrypoint}"`,
    );
    console.log(err.message);
    throw err;
  }

  const handlerFunctionName = parseFunctionName.split(',')[0];

  console.log(
    `Found exported function "${handlerFunctionName}" in "${entrypoint}"`,
  );

  // we need `main.go` in the same dir as the entrypoint,
  // otherwise `go build` will refuse to build
  const entrypointDirname = dirname(downloadedFiles[entrypoint].fsPath);

  // check if package name other than main
  const packageName = parseFunctionName.split(',')[1];
  const isGoModExist = await pathExists(join(entrypointDirname, 'go.mod'));
  if (packageName !== 'main') {
    const go = await createGo(
      goPath,
      process.platform,
      process.arch,
      {
        cwd: entrypointDirname,
      },
      true,
    );
    if (!isGoModExist) {
      try {
        const defaultGoModContent = `module ${packageName}`;

        await writeFile(join(entrypointDirname, 'go.mod'), defaultGoModContent);
      } catch (err) {
        console.log(`failed to create default go.mod for ${packageName}`);
        throw err;
      }
    }

    const mainModGoFileName = 'main__mod__.go';
    const modMainGoContents = await readFile(
      join(__dirname, mainModGoFileName),
      'utf8',
    );

    let goPackageName = `${packageName}/${packageName}`;
    const goFuncName = `${packageName}.${handlerFunctionName}`;

    if (isGoModExist) {
      const goModContents = await readFile(
        join(entrypointDirname, 'go.mod'),
        'utf8',
      );
      goPackageName = `${
        goModContents.split('\n')[0].split(' ')[1]
      }/${packageName}`;
    }

    const mainModGoContents = modMainGoContents
      .replace('__NOW_HANDLER_PACKAGE_NAME', goPackageName)
      .replace('__NOW_HANDLER_FUNC_NAME', goFuncName);

    // write main__mod__.go
    await writeFile(
      join(entrypointDirname, mainModGoFileName),
      mainModGoContents,
    );

    // move user go file to folder
    try {
      // default path
      let finalDestination = join(entrypointDirname, packageName, entrypoint);
      const entrypointArr = entrypoint.split(sep);

      // if `entrypoint` include folder, only use filename
      if (entrypointArr.length > 1) {
        finalDestination = join(
          entrypointDirname,
          packageName,
          entrypointArr.pop(),
        );
      }

      await move(downloadedFiles[entrypoint].fsPath, finalDestination);
    } catch (err) {
      console.log('failed to move entry to package folder');
      throw err;
    }

    console.log('tidy go.mod file');
    try {
      // ensure go.mod up-to-date
      await go('mod', 'tidy');
    } catch (err) {
      console.log('failed to `go mod tidy`');
      throw err;
    }

    console.log('Running `go build`...');
    const destPath = join(outDir, 'handler');
    try {
      const src = [join(entrypointDirname, mainModGoFileName)];
      await go.build({ src, dest: destPath });
    } catch (err) {
      console.log('failed to `go build`');
      throw err;
    }
  } else {
    const go = await createGo(
      goPath,
      process.platform,
      process.arch,
      {
        cwd: entrypointDirname,
      },
      false,
    );
    const origianlMainGoContents = await readFile(
      join(__dirname, 'main.go'),
      'utf8',
    );
    const mainGoContents = origianlMainGoContents.replace(
      '__NOW_HANDLER_FUNC_NAME',
      handlerFunctionName,
    );

    // in order to allow the user to have `main.go`,
    // we need our `main.go` to be called something else
    const mainGoFileName = 'main__now__go__.go';

    // Go doesn't like to build files in different directories,
    // so now we place `main.go` together with the user code
    await writeFile(join(entrypointDirname, mainGoFileName), mainGoContents);

    // `go get` will look at `*.go` (note we set `cwd`), parse the `import`s
    // and download any packages that aren't part of the stdlib
    try {
      await go.get();
    } catch (err) {
      console.log('failed to `go get`');
      throw err;
    }

    console.log('Running `go build`...');
    const destPath = join(outDir, 'handler');
    try {
      const src = [
        join(entrypointDirname, mainGoFileName),
        downloadedFiles[entrypoint].fsPath,
      ];
      await go.build({ src, dest: destPath });
    } catch (err) {
      console.log('failed to `go build`');
      throw err;
    }
  }

  const entryPath = downloadedFiles[entrypoint].fsPath;
  const extraFiles = await gatherExtraFiles(config.includeFiles, entryPath);

  const lambda = await createLambda({
    files: {
      ...extraFiles,
      ...await glob('**', outDir)
    },
    handler: 'handler',
    runtime: 'go1.x',
    environment: {},
  });

  return {
    [entrypoint]: lambda,
  };
}

module.exports = { config, build };
