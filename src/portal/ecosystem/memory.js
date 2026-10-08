import { MEMORY_FOLDER, memoryNote, safeFilePart } from './model';

export async function connectVault(tenant) {
  if (!window.showDirectoryPicker)
    throw new Error('Use Chrome or Edge to connect a folder, or download the Markdown journal.');
  const vault = await window.showDirectoryPicker({ id: 'arc-damon-memory', mode: 'readwrite' });
  const root = await vault.getDirectoryHandle(MEMORY_FOLDER, { create: true });
  const folder = await root.getDirectoryHandle(safeFilePart(tenant.id), { create: true });
  await write(
    folder,
    'Index.md',
    `# Damon Reid · ARC memory\n\nClient: ${tenant.name.replace(/[<>\[\]\r\n]/g, ' ')}\n\nTenant: ${tenant.id}\n\nEach file in Events is an observed ARC event. Synthetic events are labeled. The tab mirrors its latest 300-event window while open; the background bridge backfills the full ledger. Nothing here grants permission to send messages or enables model memory retrieval.\n\n[[Context]]\n`,
  );
  // Preserve operator-written context on every reconnect.
  try {
    await folder.getFileHandle('Context.md');
  } catch (error) {
    if (error.name !== 'NotFoundError') throw error;
    await write(
      folder,
      'Context.md',
      '# Approved business context\n\nAdd reviewed business facts and operator notes here.\n\nThese notes are local reference material. ARC does not yet read them into the production classifier. Business rules still belong in the versioned client settings.\n',
    );
  }
  return {
    vaultName: vault.name,
    folder,
    events: await folder.getDirectoryHandle('Events', { create: true }),
    written: new Set(),
  };
}
async function write(folder, name, body) {
  const file = await folder.getFileHandle(name, { create: true });
  const stream = await file.createWritable();
  try {
    await stream.write(body);
    await stream.close();
  } catch (error) {
    await stream.abort().catch(() => {});
    throw error;
  }
}
export async function syncVault(vault, events, shouldContinue = () => true) {
  for (const event of events) {
    if (!shouldContinue()) break;
    if (vault.written.has(event.id)) continue;
    await write(vault.events, `${safeFilePart(event.id)}.md`, memoryNote(event));
    vault.written.add(event.id);
  }
  return vault.written.size;
}
export function downloadJournal(events, tenantId) {
  const blob = new Blob(
    [
      `# Damon Reid memory · ${tenantId}\n\nLoaded event window only.\n\n`,
      ...events.map((e) => `${memoryNote(e)}\n\n---\n\n`),
    ],
    { type: 'text/markdown;charset=utf-8' },
  );
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `Damon-Read-Memory-${safeFilePart(tenantId)}.md`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
