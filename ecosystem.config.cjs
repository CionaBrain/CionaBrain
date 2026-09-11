module.exports = {
  apps: [
    {
      name: "cionabrain",
      cwd: "/root/CionaBrain",
      script: "/root/CionaBrain/.venv/bin/uvicorn",
      args: "app.main:app --host 0.0.0.0 --port 8765",
      interpreter: "none",
      autorestart: true,
      max_restarts: 10,
      time: true,
    },
  ],
};
