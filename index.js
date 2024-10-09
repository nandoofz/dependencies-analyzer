import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';
import { createObjectCsvWriter } from 'csv-writer';
import npmCheck from 'npm-check';
import axios from 'axios';
import semver from 'semver';

const findPackageJsonFiles = (dir) => {
  let results = [];
  const files = fs.readdirSync(dir);

  files.forEach(file => {
    const fullPath = path.join(dir, file);
    const stat = fs.statSync(fullPath);

    if (stat && stat.isDirectory() && file !== 'node_modules') {
      results = results.concat(findPackageJsonFiles(fullPath));
    } else if (file === 'package.json') {
      results.push(fullPath);
    }
  });

  return results;
};

const isCompatibleWithNodeVersion = (engineRange, nodeVersionRange) => {
  if (!engineRange) return false;
  try {
    return semver.intersects(engineRange, nodeVersionRange);
  } catch (error) {
    console.error(`Error comparing versions: ${engineRange} and ${nodeVersionRange}`, error);
    return false;
  }
};

const findLatestCompatibleVersion = (npmData, nodeVersion) => {
  if (!npmData) return 'Not informed';

  const versions = npmData.versions;
  const compatibleVersions = Object.keys(versions).filter(version => {
    const engines = versions[version]?.engines?.node;
    return isCompatibleWithNodeVersion(engines, nodeVersion);
  });

  if (compatibleVersions.length > 0) {
    return compatibleVersions[compatibleVersions.length - 1];
  }

  return 'Not informed';
};

const fetchNpmPackageInfo = async (packageName) => {
  const url = `https://registry.npmjs.org/${packageName}`;
  try {
    const response = await axios.get(url);
    return response.data;
  } catch (error) {
    return 'N/A';
  }
};

const runLibyearAnalysis = (packageJsonPath) => {
  console.log('- Running libyear analysis');
  return new Promise((resolve, reject) => {
    const dirPath = path.dirname(packageJsonPath);

    exec(`libyear --json`, { cwd: dirPath }, (error, stdout, stderr) => {
      if (error) {
        console.error(`Libyear execution error on directory ${dirPath}:`, error);
        reject(error);
      } else if (stderr) {
        console.error(`Libyear error: ${stderr}`);
        resolve(stderr);
      } else {
        resolve(JSON.parse(stdout));
      }
    });
  });
};

const runNpmCheck = async (packageJsonPath) => {
  console.log('- Running npm-check analysis');
  const dirPath = path.dirname(packageJsonPath);

  try {
    const currentState = await npmCheck({ cwd: dirPath });
    return currentState.get('packages');
  } catch (error) {
    console.error(`npm-check error for ${dirPath}:`, error);
    return [];
  }
};

const analyzeDependencies = (packageJsonPath, rootDirName) => {
  console.log('- Analyzing dependencies');
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  const productionDeps = packageJson.dependencies || {};
  const devDeps = packageJson.devDependencies || {};
  const dirName = path.basename(path.dirname(packageJsonPath));
  const module = dirName === rootDirName ? dirName : `${rootDirName}/${dirName}`;

  const dependencies = [];

  Object.keys(productionDeps).forEach(dep => {
    dependencies.push({
      dependency: dep,
      type: 'production',
      version: productionDeps[dep],
      module,
    });
  });

  Object.keys(devDeps).forEach(dep => {
    dependencies.push({
      dependency: dep,
      type: 'development',
      version: devDeps[dep],
      module,
    });
  });

  return dependencies;
};

const formatDecimal = (value) => {
  if (value !== undefined && value !== null) {
    return value.toFixed(2).replace('.', ',');
  }
  return 'Unknown';
};

const formatDependencyResult = (dep, libyearDepResult, npmCheckResult, node16Version, node18Version, node20Version) => {
  const npmCheckData = npmCheckResult || {};

  return {
    module: dep.module,
    dependency: dep.dependency,
    type: dep.type,
    currentVersion: dep.version,
    latestVersion: libyearDepResult?.available || 'Unknown',
    npmLatest: npmCheckData.latest || 'Unknown',
    npmWanted: npmCheckData.packageWanted || 'Unknown',
    easyUpgrade: npmCheckData.easyUpgrade || false,
    node16Version,
    node18Version,
    node20Version,
    unused: npmCheckData.unused || false,
    drift: formatDecimal(libyearDepResult?.drift),
    pulse: formatDecimal(libyearDepResult?.pulse),
    releases: libyearDepResult?.releases || '0',
    major: libyearDepResult?.major || '0',
    minor: libyearDepResult?.minor || '0',
    patch: libyearDepResult?.patch || '0',
  };
};

const generateCsv = async (data, rootDirName) => {
  const csvWriter = createObjectCsvWriter({
    path: `analysis-result-${rootDirName}.csv`,
    header: [
      { id: 'module', title: 'Module' },
      { id: 'dependency', title: 'Dependency' },
      { id: 'type', title: 'Type' },
      { id: 'currentVersion', title: 'Current version' },
      { id: 'latestVersion', title: 'Libyear latest version' },
      { id: 'npmLatest', title: 'NPM latest version' },
      { id: 'npmWanted', title: 'Wanted version' },
      { id: 'easyUpgrade', title: 'Easy upgrade' },
      { id: 'node16Version', title: 'Node 16' },
      { id: 'node18Version', title: 'Node 18' },
      { id: 'node20Version', title: 'Node 20' },
      { id: 'unused', title: 'Unused' },
      { id: 'drift', title: 'Drift' },
      { id: 'pulse', title: 'Pulse' },
      { id: 'releases', title: 'Releases' },
      { id: 'major', title: 'Major' },
      { id: 'minor', title: 'Minor' },
      { id: 'patch', title: 'Patch' },
    ],
    fieldDelimiter: ';'
  });

  await csvWriter.writeRecords(data);
  console.log('= CSV file was written successfully');
};

const findNodeCompatibility = async (dependency) => {
  const npmData = await fetchNpmPackageInfo(dependency);

  if (!npmData || npmData === 'N/A') {
    return { node16Version: 'N/A', node18Version: 'N/A', node20Version: 'N/A' };
  }

  const node16Version = findLatestCompatibleVersion(npmData, '^16.0.0');
  const node18Version = findLatestCompatibleVersion(npmData, '^18.0.0');
  const node20Version = findLatestCompatibleVersion(npmData, '^20.0.0');

  return { node16Version, node18Version, node20Version };
};

const runNodeCompatibility = async (dependencies) => {
  console.log('- Running node compatibility analysis');
  const results = [];
  for (const dep of dependencies) {
    const nodeCompatibility = await findNodeCompatibility(dep.dependency);
    results.push({ dependency: dep.dependency, ...nodeCompatibility });
  }

  return results;
};

(async () => {
  console.log('=== Starting analysis... (this process may take a while)');
  const rootDir = process.argv[2] || './';

  if (!fs.existsSync(rootDir)) {
    console.error('Directory not found:', rootDir);
    process.exit(1);
  }

  const rootDirName = path.basename(rootDir);
  const packageJsonFiles = findPackageJsonFiles(rootDir);
  const csvData = [];

  let i = 1;
  for (const file of packageJsonFiles) {
    console.log(`\n= File (${i}/${packageJsonFiles.length}): ${file}`);
    const dependencies = analyzeDependencies(file, rootDirName);
    const libyearResults = await runLibyearAnalysis(file);
    const npmCheckResults = await runNpmCheck(file);
    const nodeCompatibilityResults = await runNodeCompatibility(dependencies);

    if (!libyearResults || !Array.isArray(libyearResults)) {
      console.error(`No valid data from libyear for ${file}`);
      continue;
    }

    for (const dep of dependencies) {
      const libyearDepResult = libyearResults.find(result => result.dependency === dep.dependency);
      const npmCheckDepResult = npmCheckResults.find(result => result.moduleName === dep.dependency);
      const nodeCompatibilityResult = nodeCompatibilityResults.find(result => result.dependency === dep.dependency);
      const result = formatDependencyResult(dep, libyearDepResult, npmCheckDepResult, nodeCompatibilityResult.node16Version, nodeCompatibilityResult.node18Version, nodeCompatibilityResult.node20Version);
      csvData.push(result);
    }
    i += 1;
  }

  await generateCsv(csvData, rootDirName);
  console.log('=== Analysis completed');
})();
