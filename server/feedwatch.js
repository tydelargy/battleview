// Call `onChange` when the feed file changes. Watches the directory, not the file: a sync job that writes a temp
// file and renames it over the feed (the safe way) gives the file a new inode, and a watch on the old inode goes
// quiet after one event. Events for other files in the directory are ignored.
import fs from 'node:fs';
import path from 'node:path';

export function watchFeed(file, onChange, { debounceMs = 150 } = {}) {
  const dir = path.dirname(path.resolve(file)), base = path.basename(file);
  let timer;
  const w = fs.watch(dir, (_event, name) => {
    if (name && name !== base) return;   // some platforms give no name; then any change counts
    clearTimeout(timer); timer = setTimeout(onChange, debounceMs);
  });
  return { close() { clearTimeout(timer); w.close(); } };
}
