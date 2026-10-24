import { afterEach, beforeEach, vi } from 'vitest';
import { keepFor } from '../src/mailbox';
import { mockFetch } from './helpers';

// Page answers are kept a minute in production; tests read their own writes at once.
keepFor.ms = 0;

// Every test answers Access's certs fetch; any other outside call fails unless a test mocks it.
beforeEach(() => void mockFetch());
afterEach(() => vi.restoreAllMocks());
