import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { UpdateBanner } from './UpdateBanner';

const noop = () => {};

describe('UpdateBanner', () => {
  it('renders nothing while idle or checking', () => {
    const { container, rerender } = render(
      <UpdateBanner status="idle" version={null} progress={null} onDownload={noop} onRestart={noop} onDismiss={noop} />,
    );
    expect(container).toBeEmptyDOMElement();
    rerender(
      <UpdateBanner status="checking" version={null} progress={null} onDownload={noop} onRestart={noop} onDismiss={noop} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('offers to download an available update', () => {
    const onDownload = vi.fn();
    render(
      <UpdateBanner status="available" version="9.9.9" progress={null} onDownload={onDownload} onRestart={noop} onDismiss={noop} />,
    );
    expect(screen.getByText(/new version available \(v9\.9\.9\)/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /download/i }));
    expect(onDownload).toHaveBeenCalledOnce();
  });

  it('shows a percentage while downloading', () => {
    render(
      <UpdateBanner status="downloading" version="9.9.9" progress={0.42} onDownload={noop} onRestart={noop} onDismiss={noop} />,
    );
    expect(screen.getByText('42%')).toBeInTheDocument();
  });

  it('offers restart when ready', () => {
    const onRestart = vi.fn();
    render(
      <UpdateBanner status="ready" version="9.9.9" progress={null} onDownload={noop} onRestart={onRestart} onDismiss={noop} />,
    );
    expect(screen.getByText(/update ready \(v9\.9\.9\)/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /restart now/i }));
    expect(onRestart).toHaveBeenCalledOnce();
  });

  it('is dismissible on error', () => {
    const onDismiss = vi.fn();
    render(
      <UpdateBanner status="error" version={null} progress={null} onDownload={noop} onRestart={noop} onDismiss={onDismiss} />,
    );
    fireEvent.click(screen.getByRole('button', { name: /dismiss/i }));
    expect(onDismiss).toHaveBeenCalledOnce();
  });
});
