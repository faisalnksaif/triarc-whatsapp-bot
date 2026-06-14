module.exports = {
  apps: [
    {
      name: 'triarc-whatsapp-bot',
      script: './node_modules/.bin/tsx',
      args: 'src/index.ts',
      cwd: __dirname,
      watch: false,
      restart_delay: 5000,
      max_restarts: 10,
      env: {
        NODE_ENV: 'production',
        PORT: '9001',
      },
    },
  ],
}
