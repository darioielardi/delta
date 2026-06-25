/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Dev-only flag: install the fixture IPC backend (src/dev/mockBackend.ts). */
  readonly VITE_MOCK_IPC?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
