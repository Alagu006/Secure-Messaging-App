import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import fs from 'fs'

const httpsConfig = (() => {
  const certFile = '../backend/certs/cert.pem';
  const keyFile = '../backend/certs/key.pem';
  if (fs.existsSync(certFile) && fs.existsSync(keyFile)) {
    return { key: fs.readFileSync(keyFile), cert: fs.readFileSync(certFile) };
  }
  return false;
})();

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    https: httpsConfig,
    proxy: {
      '/ws': { target: httpsConfig ? 'https://localhost:8000' : 'http://localhost:8000', ws: true, secure: false },
      '/auth': { target: httpsConfig ? 'https://localhost:8000' : 'http://localhost:8000', secure: false },
      '/files': { target: httpsConfig ? 'https://localhost:8000' : 'http://localhost:8000', secure: false },
      '/health': { target: httpsConfig ? 'https://localhost:8000' : 'http://localhost:8000', secure: false },
      '/messages': { target: httpsConfig ? 'https://localhost:8000' : 'http://localhost:8000', secure: false },
    },
  },
})
