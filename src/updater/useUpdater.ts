import { useCallback, useEffect, useRef, useState } from 'react';
import { track } from '@/analytics';
import { isTauri } from '@tauri-apps/api/core';
import { check, type Update } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import { api } from '../api';

export type UpdaterStatus = 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'error';

export interface UpdaterState {
  status: UpdaterStatus;
  version: string | null;
  /** 0..1 while downloading; null when unknown (pre-start / indeterminate). */
  progress: number | null;
  /** User-initiated: start downloading + installing the available update. */
  download: () => void;
  restart: () => Promise<void>;
}

// Checks for an update on mount (once per app process — see the leader-election
// gate) and surfaces it as `available`; the download only starts when the user
// asks via `download()`. Flow: checking → available → downloading → ready.
export function useUpdater(): UpdaterState {
  const [status, setStatus] = useState<UpdaterStatus>('idle');
  const [version, setVersion] = useState<string | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const updateRef = useRef<Update | null>(null);

  useEffect(() => {
    if (!isTauri()) return; // dev / dev:mock — no Tauri IPC available
    let cancelled = false;
    (async () => {
      try {
        // Only one window per app process checks/downloads; other windows lose the
        // gate and stay idle, so concurrent windows never race on the download /
        // .app replacement. (#updater-race)
        const acquired = await api.acquireUpdaterGate();
        if (cancelled || !acquired) return;
        setStatus('checking');
        const update = await check();
        if (cancelled) return;
        if (!update) {
          setStatus('idle');
          return;
        }
        updateRef.current = update;
        setVersion(update.version);
        setStatus('available'); // wait for the user to start the download
      } catch (err) {
        console.error('updater: check failed', err);
        if (!cancelled) setStatus('error');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const download = useCallback(() => {
    const update = updateRef.current;
    if (!update) return;
    setStatus('downloading');
    let downloaded = 0;
    let total = 0;
    void (async () => {
      try {
        await update.downloadAndInstall((e) => {
          switch (e.event) {
            case 'Started':
              total = e.data.contentLength ?? 0;
              setProgress(total > 0 ? 0 : null);
              break;
            case 'Progress':
              downloaded += e.data.chunkLength;
              if (total > 0) setProgress(Math.min(1, downloaded / total));
              break;
            case 'Finished':
              setProgress(1);
              break;
          }
        });
        setStatus('ready');
        track('update_applied');
      } catch (err) {
        console.error('updater: download failed', err);
        setStatus('error');
      }
    })();
  }, []);

  return { status, version, progress, download, restart: relaunch };
}
