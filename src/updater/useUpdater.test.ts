import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ isTauri: vi.fn() }));
vi.mock('@tauri-apps/plugin-updater', () => ({ check: vi.fn() }));
vi.mock('@tauri-apps/plugin-process', () => ({ relaunch: vi.fn() }));
vi.mock('../api', () => ({ api: { acquireUpdaterGate: vi.fn() } }));

import { isTauri } from '@tauri-apps/api/core';
import { check } from '@tauri-apps/plugin-updater';
import { api } from '../api';
import { useUpdater } from './useUpdater';

describe('useUpdater', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: this window wins the gate. The contention case overrides to false.
    vi.mocked(api.acquireUpdaterGate).mockResolvedValue(true);
  });

  it('never checks outside Tauri', () => {
    vi.mocked(isTauri).mockReturnValue(false);
    const { result } = renderHook(() => useUpdater());
    expect(result.current.status).toBe('idle');
    expect(check).not.toHaveBeenCalled();
  });

  it('skips the check when another window already owns the update', async () => {
    vi.mocked(isTauri).mockReturnValue(true);
    vi.mocked(api.acquireUpdaterGate).mockResolvedValue(false);
    const { result } = renderHook(() => useUpdater());
    await waitFor(() => expect(api.acquireUpdaterGate).toHaveBeenCalledOnce());
    expect(check).not.toHaveBeenCalled();
    expect(result.current.status).toBe('idle');
  });

  it('stays idle when there is no update', async () => {
    vi.mocked(isTauri).mockReturnValue(true);
    vi.mocked(check).mockResolvedValue(null);
    const { result } = renderHook(() => useUpdater());
    await waitFor(() => expect(result.current.status).toBe('idle'));
    expect(check).toHaveBeenCalledOnce();
  });

  it('surfaces an available update without downloading it', async () => {
    vi.mocked(isTauri).mockReturnValue(true);
    const downloadAndInstall = vi.fn().mockResolvedValue(undefined);
    vi.mocked(check).mockResolvedValue({ version: '9.9.9', downloadAndInstall } as never);
    const { result } = renderHook(() => useUpdater());
    await waitFor(() => expect(result.current.status).toBe('available'));
    expect(result.current.version).toBe('9.9.9');
    expect(downloadAndInstall).not.toHaveBeenCalled();
  });

  it('downloads and becomes ready once the user starts it', async () => {
    vi.mocked(isTauri).mockReturnValue(true);
    const downloadAndInstall = vi.fn().mockResolvedValue(undefined);
    vi.mocked(check).mockResolvedValue({ version: '9.9.9', downloadAndInstall } as never);
    const { result } = renderHook(() => useUpdater());
    await waitFor(() => expect(result.current.status).toBe('available'));
    act(() => result.current.download());
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(downloadAndInstall).toHaveBeenCalledOnce();
  });

  it('enters error state when check throws', async () => {
    vi.mocked(isTauri).mockReturnValue(true);
    vi.mocked(check).mockRejectedValue(new Error('network'));
    const { result } = renderHook(() => useUpdater());
    await waitFor(() => expect(result.current.status).toBe('error'));
  });
});
