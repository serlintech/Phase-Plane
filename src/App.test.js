import { render, screen } from '@testing-library/react';

jest.mock('./PhasePlane', () => () => <div>Phase Plane</div>);

import App from './App';

test('renders phase plane heading', () => {
  render(<App />);
  const title = screen.getByText(/phase plane/i);
  expect(title).toBeInTheDocument();
});
