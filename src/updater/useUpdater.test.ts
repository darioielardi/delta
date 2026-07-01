import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ isTauri: vi.fn() }));
vi.mock('@tauri-apps/plugin-updater', () => ({ check: vi.fn() }));
vi.mock('@tauri-apps/plugin-process', () => ({ relaunch: vi.fn() }));

import { isTauri } from '@tauri-apps/api/core';
import { check } from '@tauri-apps/plugin-updater';
import { useUpdater } from './useUpdater';

describe('useUpdater', () => {
  beforeEach(() => vi.clearAllMocks());

  it('never checks outside Tauri', () => {
    vi.mocked(isTauri).mockReturnValue(false);
    const { result } = renderHook(() => useUpdater());
    expect(result.current.status).toBe('idle');
    expect(check).not.toHaveBeenCalled();
  });

  it('stays idle when there is no update', async () => {
    vi.mocked(isTauri).mockReturnValue(true);
    vi.mocked(check).mockResolvedValue(null);
    const { result } = renderHook(() => useUpdater());
    await waitFor(() => expect(result.current.status).toBe('idle'));
    expect(check).toHaveBeenCalledOnce();
  });

  it('downloads and becomes ready when an update exists', async () => {
    vi.mocked(isTauri).mockReturnValue(true);
    const downloadAndInstall = vi.fn().mockResolvedValue(undefined);
    vi.mocked(check).mockResolvedValue({ version: '9.9.9', downloadAndInstall } as never);
    const { result } = renderHook(() => useUpdater());
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.version).toBe('9.9.9');
    expect(downloadAndInstall).toHaveBeenCalledOnce();
  });

  it('enters error state when check throws', async () => {
    vi.mocked(isTauri).mockReturnValue(true);
    vi.mocked(check).mockRejectedValue(new Error('network'));
    const { result } = renderHook(() => useUpdater());
    await waitFor(() => expect(result.current.status).toBe('error'));
  });
});
