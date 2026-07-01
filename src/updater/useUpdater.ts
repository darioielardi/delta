import { useEffect, useState } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { check } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';

export type UpdaterStatus = 'idle' | 'checking' | 'downloading' | 'ready' | 'error';

export interface UpdaterState {
  status: UpdaterStatus;
  version: string | null;
  restart: () => Promise<void>;
}

export function useUpdater(): UpdaterState {
  const [status, setStatus] = useState<UpdaterStatus>('idle');
  const [version, setVersion] = useState<string | null>(null);

  useEffect(() => {
    if (!isTauri()) return; // dev / dev:mock — no Tauri IPC available
    let cancelled = false;
    (async () => {
      try {
        setStatus('checking');
        const update = await check();
        if (cancelled) return;
        if (!update) {
          setStatus('idle');
          return;
        }
        setVersion(update.version);
        setStatus('downloading');
        await update.downloadAndInstall();
        if (!cancelled) setStatus('ready');
      } catch (err) {
        console.error('updater: check/download failed', err);
        if (!cancelled) setStatus('error');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return { status, version, restart: relaunch };
}
