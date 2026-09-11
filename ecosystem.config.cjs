module.exports = {
  apps: [
    {
      name: "cionabrain",
      cwd: "/root/CionaBrain",
      script: "/root/CionaBrain/dist/server.js",
      interpreter: "/usr/bin/node",
      env: { PORT: "8765", NODE_ENV: "production" },
      autorestart: true,
      max_restarts: 10,
      time: true,
    },
  ],
};
