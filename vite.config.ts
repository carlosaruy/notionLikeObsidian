import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  // Load .env files
  const env = loadEnv(mode, process.cwd(), '')

  return {
    plugins: [react()],
    server: {
      proxy: {
        // Secure proxy: token lives only on the dev server (from .env)
        // Frontend calls /notion-api/... and we forward to Notion with the real token
        '/notion-api': {
          target: 'https://api.notion.com',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/notion-api/, ''),
          headers: {
            'Authorization': `Bearer ${env.NOTION_TOKEN}`,
            'Notion-Version': '2022-06-28',
          },
        },
      },
    },
  }
})
