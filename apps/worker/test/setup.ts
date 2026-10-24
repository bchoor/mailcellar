import { afterEach, beforeEach, vi } from 'vitest';
import { mockFetch } from './helpers';

// Every test answers Access's certs fetch; any other outside call fails unless a test mocks it.
beforeEach(() => void mockFetch());
afterEach(() => vi.restoreAllMocks());
