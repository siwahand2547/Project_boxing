// config.js
module.exports = {
  COM_PORT_1: 'COM4',
  COM_PORT_2: 'COM5',
  BAUD_RATE: 115200, // ปรับจาก 9600 เพื่อส่งข้อมูลเร็วขึ้น (เช็คว่า hardware รองรับ)
  SENSOR_TIMEOUT: 200, // ลดจาก 2000ms เพื่อส่ง maxValue เร็วถ้าค้าง
  INTERVAL_CHECK: 50, // ลดจาก 500ms เพื่อเช็ค buffer บ่อยขึ้น
  DB_CONFIG: {
    host: 'localhost',
    user: 'root',
    password: '',
    database: 'project_boxing',
    connectionLimit: 10
  },
  SOCKET_EVENTS: {
    CONNECTION_STATUS: 'connectionStatus',
    CONNECTION_ERROR: 'connectionError',
    COM_PORT_1_DATA: 'COM_PORT_1_DATA',
    COM_PORT_2_DATA: 'COM_PORT_2_DATA',
    COM_PORT_1_STATUS: 'COM_PORT_1_STATUS',
    COM_PORT_2_STATUS: 'COM_PORT_2_STATUS',
    TIMEOUT_DATA: 'timeoutData' // เพิ่มเผื่ออนาคต (ไม่ได้ใช้ตอนนี้)
  },
  LOG_FILE: 'error.log'
};