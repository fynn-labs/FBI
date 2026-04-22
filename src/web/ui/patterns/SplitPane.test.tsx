import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { SplitPane } from './SplitPane.js';

describe('SplitPane', () => {
  it('renders left and right panels', () => {
    render(<SplitPane left={<div>L</div>} right={<div>R</div>} />);
    expect(screen.getByText('L')).toBeInTheDocument();
    expect(screen.getByText('R')).toBeInTheDocument();
  });
});
