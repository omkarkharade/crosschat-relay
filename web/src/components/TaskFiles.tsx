import { useMemo, useState } from 'react';

import { api } from '../api';
import type { ActivityEntry, ChangedFile } from '../types';
import { errorMessage, useToast } from './ui';

const IMAGE = /\.(png|jpe?g|gif|webp|bmp|svg)$/i;
const FIRST_IMAGES = 24;
const CHANGE_LABEL: Record<ChangedFile['change'], string> = { added: 'Added', changed: 'Changed', deleted: 'Deleted' };

/**
 * The files worker runs on a task added, changed, or deleted, with previews of
 * pictures. Previews and "Show in folder" work on the relay's own computer.
 */
export function TaskFiles({ taskId, entries, local }: { taskId: string; entries: ActivityEntry[]; local: boolean }) {
  const [showAll, setShowAll] = useState(false);
  const toast = useToast();

  // The latest run's word on each file wins; `version` refreshes previews after a later run.
  const files = useMemo(() => {
    const byPath = new Map<string, ChangedFile & { version: number }>();
    for (const entry of entries) for (const file of entry.files ?? []) byPath.set(file.path, { ...file, version: entry.seq });
    return [...byPath.values()];
  }, [entries]);

  if (files.length === 0) return null;
  const images = files.filter((file) => file.change !== 'deleted' && IMAGE.test(file.path));
  const others = files.filter((file) => !images.includes(file));
  const shownImages = showAll ? images : images.slice(0, FIRST_IMAGES);

  async function reveal(path: string) {
    try {
      await api.reveal(taskId, path);
    } catch (failure: unknown) {
      toast(errorMessage(failure));
    }
  }

  return (
    <section className="drawer-section" aria-label="Files">
      <div className="section-heading">
        <h3>Files</h3>
        <span className="muted files-count">{summary(files)}</span>
      </div>
      {local && shownImages.length > 0 && (
        <ul className="file-previews">
          {shownImages.map((file) => {
            const url = `${api.fileUrl(taskId, file.path)}&v=${file.version}`;
            return (
              <li key={file.path}>
                <a href={url} target="_blank" rel="noreferrer" className="file-preview" title={file.path}>
                  <img src={url} alt="" loading="lazy" onError={(event) => (event.currentTarget.style.visibility = 'hidden')} />
                </a>
                <button type="button" className="file-caption" onClick={() => void reveal(file.path)} title={`${CHANGE_LABEL[file.change]} · Show in folder`}>
                  {baseName(file.path)}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {local && images.length > FIRST_IMAGES && (
        <button type="button" className="button button-small" onClick={() => setShowAll(!showAll)}>
          {showAll ? 'Show fewer' : `Show all ${images.length} pictures`}
        </button>
      )}
      {(local ? others : files).length > 0 && (
        <ul className="file-list">
          {(local ? others : files).map((file) => (
            <li key={file.path} className={`file-row file-${file.change}`}>
              <span className="file-change">{CHANGE_LABEL[file.change]}</span>
              <span className="file-path mono" title={file.path}>
                <strong>{baseName(file.path)}</strong>
                <span className="muted"> {folderOf(file.path)}</span>
              </span>
              {local && (
                <button type="button" className="button button-small" onClick={() => void reveal(file.path)}>
                  {file.change === 'deleted' ? 'Open folder' : 'Show in folder'}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {!local && <p className="muted">Previews and “Show in folder” work on the computer the relay runs on.</p>}
    </section>
  );
}

function summary(files: ChangedFile[]): string {
  const count = (change: ChangedFile['change']) => files.filter((file) => file.change === change).length;
  return [count('added') && `${count('added')} added`, count('changed') && `${count('changed')} changed`, count('deleted') && `${count('deleted')} deleted`]
    .filter(Boolean)
    .join(' · ');
}

function baseName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

function folderOf(path: string): string {
  return path.slice(0, path.length - baseName(path).length).replace(/[\\/]$/, '');
}
