// db.js
const mysql = require('mysql2/promise');
const winston = require('winston');
const config = require('./config');

const { DB_CONFIG, LOG_FILE } = config;

// Logger setup
const logger = winston.createLogger({
  level: 'error',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.File({ filename: LOG_FILE })
  ]
});

// Create connection pool
const pool = mysql.createPool({
  ...DB_CONFIG,
  database: 'project_boxing' // Override database name
});

// Test initial connection
const testConnection = async (maxRetries = 3, retryDelay = 2000) => {
  let retryCount = 0;
  while (retryCount < maxRetries) {
    try {
      const connection = await pool.getConnection();
      console.log('✅ Connected to MySQL DB');
      connection.release();
      return;
    } catch (err) {
      retryCount++;
      logger.error(`Error connecting to DB (attempt ${retryCount}/${maxRetries}): ${err.message}`);
      console.error(`❌ Error connecting to DB (attempt ${retryCount}/${maxRetries}):`, err.message);
      if (retryCount === maxRetries) {
        logger.error('Failed to connect to DB after max retries');
        throw new Error('Failed to connect to database');
      }
      await new Promise(resolve => setTimeout(resolve, retryDelay));
    }
  }
};

// Initialize connection
testConnection().catch(err => {
  console.error('🚫 Database connection failed:', err.message);
  process.exit(1); // Exit process if DB connection fails
});

// Track pool state
let isPoolClosed = false;

// Export pool and close function
module.exports = {
  pool,
  close: async () => {
    if (isPoolClosed) {
      console.log('Database connection pool already closed');
      return;
    }
    try {
      await pool.end();
      isPoolClosed = true;
      console.log('Database connection pool closed');
    } catch (err) {
      logger.error(`Error closing database pool: ${err.message}`);
      console.error('Error closing database pool:', err.message);
      throw err; // โยนข้อผิดพลาดเพื่อให้ caller จัดการ
    }
  }
};