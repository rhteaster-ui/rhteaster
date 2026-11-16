const os = require("os");
const path = require("path");

const homeDir = process.env.HOME || os.homedir();
const safePath = `${path.join(homeDir, ".local", "bin")}:/usr/local/bin:${process.env.PATH || "/usr/bin:/bin"}`;

module.exports = {
  apps: [
    {
      name: "wa-bot",
      script: path.join(__dirname, "index.js"),
      cwd: __dirname,
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: "500M",
      restart_delay: 4000,
      out_file: path.join(__dirname, "logs", "wa-bot-out.log"),
      error_file: path.join(__dirname, "logs", "wa-bot-error.log"),
      merge_logs: true,
      time: true,
      env: {
        NODE_ENV: "production",
        HOME: homeDir,
        PATH: safePath
      }
    },
    {
      name: "agent-dashboard",
      script: path.join(__dirname, "dashboard", "server.js"),
      cwd: __dirname,
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: "350M",
      restart_delay: 3000,
      out_file: path.join(__dirname, "logs", "agent-dashboard-out.log"),
      error_file: path.join(__dirname, "logs", "agent-dashboard-error.log"),
      merge_logs: true,
      time: true,
      env: {
        NODE_ENV: "production",
        HOME: homeDir,
        PATH: safePath
      }
    }
  ]
};
