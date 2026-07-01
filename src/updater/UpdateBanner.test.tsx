import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { UpdateBanner } from './UpdateBanner';

describe('UpdateBanner', () => {
  it('shows the version and both actions', () => {
    const onRestart = vi.fn();
    const onDismiss = vi.fn();
    render(<UpdateBanner version="1.2.3" onRestart={onRestart} onDismiss={onDismiss} />);
    expect(screen.getByText(/1\.2\.3/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /restart now/i }));
    expect(onRestart).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: /later/i }));
    expect(onDismiss).toHaveBeenCalledOnce();
  });
});
