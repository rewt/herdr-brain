// Display-only durable locations. Resolving a declaration never creates or
// reads its directories, grants access, or authorizes lane cleanup.
import fs from 'node:fs';
import path from 'node:path';
import { gitProject } from './project.mjs';
import { loadDiscoveredRoutes, readRoutesConfig } from '../lanes/routes.mjs';

export function validateArchive(config, file) {
  if (!Object.hasOwn(config, 'archive')) return;
  const archive = config.archive;
  if (!archive || typeof archive !== 'object' || Array.isArray(archive) || !Array.isArray(archive.dirs) ||
      archive.dirs.some(dir => typeof dir !== 'string' || !dir.trim() || /[\0\r\n]/u.test(dir)))
    throw Error(`invalid lane config ${file}: archive.dirs must be an array of nonempty directory paths`);
}

// Match lane's whole-value, parent-then-repository replacement semantics while
// retaining the declaring file as the base for relative paths. [] opts out.
export function resolveArchive({ canonical, layers }) {
  let declared;
  for (const layer of layers) {
    validateArchive(layer.config, layer.file);
    if (Object.hasOwn(layer.config, 'archive')) declared = layer;
  }
  if (declared) return { dirs: declared.config.archive.dirs.map(dir => path.resolve(path.dirname(declared.file), dir)), source: declared.file };
  const fallback = canonical && path.join(path.dirname(canonical), 'archive');
  let exists = false;
  if (fallback) try { exists = fs.statSync(fallback).isDirectory(); }
  catch (error) { if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error; }
  return { dirs: exists ? [fallback] : [], source: 'default' };
}

export function discoverArchive({ cwd = process.cwd(), env = process.env, project } = {}) {
  // A historical run may have lost its workspace. Do not borrow the caller's
  // project locations when rendering that run's brief.
  if (!fs.existsSync(cwd)) return { dirs: [], source: 'default' };
  if (!project) try { project = gitProject(cwd, { env }); } catch { /* Standalone records also have briefs. */ }
  // Explicit configuration is caller-relative, even when the displayed run
  // belongs to a different workspace.
  const file = env.LANE_CONFIG === undefined ? undefined : path.resolve(process.cwd(), env.LANE_CONFIG);
  const { files } = loadDiscoveredRoutes({ cwd, env, file });
  return resolveArchive({ canonical: project?.canonical,
    layers: files.map(file => ({ file, config: readRoutesConfig(file) })) });
}
