const express = require('express');
const http = require('http');
const path = require('path');
const { SerialPort } = require('serialport');
const { ReadlineParser } = require('@serialport/parser-readline');
const socketIo = require('socket.io');
const multer = require('multer');
const fs = require('fs');
const winston = require('winston');
const config = require('./config');
const db = require('./db');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);
const { SENSOR_TIMEOUT = 1000, INTERVAL_CHECK = 500, SOCKET_EVENTS = {
  CONNECTION_STATUS: 'connectionStatus',
  CONNECTION_ERROR: 'connectionError',
  COM_PORT_1_DATA: 'COM_PORT_1_DATA',
  COM_PORT_2_DATA: 'COM_PORT_2_DATA'
}, LOG_FILE = 'error.log' } = config;

// Hardcode BAUD_RATE to 115200 for device compatibility
const BAUD_RATE = 115200;

// Logger setup
const logger = winston.createLogger({
  level: 'error',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.File({ filename: LOG_FILE }),
    new winston.transports.Console()
  ]
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Multer configuration for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'public/uploads/'),
  filename: (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname))
});
const upload = multer({ storage });

// Serial port variables
let portCOM1, portCOM2;
let isCOM1Connected = false, isCOM2Connected = false;
let currentFighterPort1 = null, currentFighterPort2 = null;
const portStates = new Map();

// Update connection status
const updateConnectionStatus = () => {
  io.emit(SOCKET_EVENTS.CONNECTION_STATUS, {
    fighterPort1: isCOM1Connected ? currentFighterPort1 : null,
    fighterPort2: isCOM2Connected ? currentFighterPort2 : null
  });
};

// Process sensor data
const processSensorData = (rawData, portName, state, emitEvent) => {
  console.log(`📥 ข้อมูลดิบจาก ${portName}:`, rawData);
  const parts = rawData.split(',').map((v, i) => i === 4 ? parseFloat(v.trim()) : parseInt(v.trim(), 10));
  if (parts.length !== 6 || parts.some(v => isNaN(v) && v !== 0)) {
    console.error(`🚫 ข้อมูลไม่ถูกต้องจาก ${portName}:`, rawData);
    logger.error(`Invalid data from ${portName}: ${rawData}`);
    return;
  }
  const [chestVal, stomachVal, leftVal, rightVal, headVal, fallVal] = parts;
  const now = Date.now();
  let result = {};
  const sensors = [
    { name: 'chest', value: chestVal, threshold: 1500 },
    { name: 'stomach', value: stomachVal, threshold: 1500 },
    { name: 'left', value: leftVal, threshold: 1500 },
    { name: 'right', value: rightVal, threshold: 1500 },
    { name: 'head', value: headVal, threshold: 40 } // Changed threshold from 5 to 40
  ];
  sensors.forEach(({ name, value, threshold }) => {
    if (value >= threshold) {
      state.buffers[name].push(value);
      state.waiting[name] = true;
      state.lastTime[name] = now;
    } else if (state.waiting[name] && state.buffers[name].length > 0) {
      const maxValue = Math.max(...state.buffers[name]);
      if (maxValue >= threshold) result[name] = maxValue;
      state.buffers[name] = [];
      state.waiting[name] = false;
    }
  });
  if (fallVal === 1) {
    result.fall = 1;
    console.log(`⚠️ Fall detected for ${portName}`);
  }
  if (Object.keys(result).length > 0) {
    if (Object.keys(result).length > 1 && !result.fall) {
      const values = Object.values(result);
      const firstValue = values[0];
      const allEqual = values.every(v => v === firstValue);
      if (allEqual) {
        const sensorsOrder = ['right', 'left', 'stomach', 'chest', 'head'];
        const lastKey = sensorsOrder.find(name => result[name]);
        result = { [lastKey]: result[lastKey] };
        sensors.forEach(({ name }) => {
          state.buffers[name] = [];
          state.waiting[name] = false;
        });
      }
    }
    console.log(`✅ ส่งข้อมูล ${portName}:`, result);
    io.emit(emitEvent, result);
  }
};

// Setup serial port with retry
const setupFighterPort = async (portPath, portName, emitEvent, maxRetries = 3) => {
  let retryCount = 0;
  const tryConnect = async () => {
    try {
      const ports = await SerialPort.list();
      if (!ports.some(p => p.path === portPath)) {
        throw new Error(`พอร์ต ${portPath} ไม่มี`);
      }
      const port = new SerialPort({ path: portPath, baudRate: BAUD_RATE });
      console.log(`✅ เชื่อมต่อ ${portName} (${portPath}) สำเร็จ`);
      portStates.set(portPath, {
        buffers: { chest: [], stomach: [], left: [], right: [], head: [] },
        waiting: { chest: false, stomach: false, left: false, right: false, head: false },
        lastTime: { chest: Date.now(), stomach: Date.now(), left: Date.now(), right: Date.now(), head: Date.now() }
      });
      if (portName === 'Fighter1') {
        isCOM1Connected = true;
        portCOM1 = port;
      } else {
        isCOM2Connected = true;
        portCOM2 = port;
      }
      updateConnectionStatus();

      const parser = port.pipe(new ReadlineParser({ delimiter: '\r\n' }));
      parser.on('data', (rawData) => processSensorData(rawData, portName, portStates.get(portPath), emitEvent));

      port.on('close', () => {
        console.log(`🔌 ${portName} ตัดการเชื่อมต่อ`);
        portStates.delete(portPath);
        if (portName === 'Fighter1') {
          isCOM1Connected = false;
          portCOM1 = null;
        } else {
          isCOM2Connected = false;
          portCOM2 = null;
        }
        updateConnectionStatus();
      });

      port.on('error', (err) => {
        console.error(`❌ ข้อผิดพลาด ${portName}:`, err.message);
        logger.error(`Port error ${portName}: ${err.message}`);
        io.emit(SOCKET_EVENTS.CONNECTION_ERROR, `ข้อผิดพลาด ${portName}: ${err.message}`);
        portStates.delete(portPath);
        if (portName === 'Fighter1') {
          isCOM1Connected = false;
          portCOM1 = null;
        } else {
          isCOM2Connected = false;
          portCOM2 = null;
        }
        updateConnectionStatus();
      });

      return port;
    } catch (err) {
      console.error(`❌ ล้มเหลว ${portName} (${portPath}):`, err.message);
      logger.error(`Failed to connect ${portName}: ${err.message}`);
      if (retryCount < maxRetries) {
        retryCount++;
        console.log(`🔄 ลองใหม่ ${portName} (${retryCount}/${maxRetries})`);
        await new Promise(resolve => setTimeout(resolve, 2000));
        return tryConnect();
      }
      io.emit(SOCKET_EVENTS.CONNECTION_ERROR, `ไม่สามารถเชื่อมต่อ ${portName} (${portPath}): ${err.message}`);
      if (portName === 'Fighter1') isCOM1Connected = false;
      else isCOM2Connected = false;
      updateConnectionStatus();
      throw err;
    }
  };
  return tryConnect();
};

// Setup for Fighter 1
const setupFighter1 = async (port) => {
  isCOM1Connected = false;
  currentFighterPort1 = port;
  return setupFighterPort(port, 'Fighter1', SOCKET_EVENTS.COM_PORT_1_DATA);
};

// Setup for Fighter 2
const setupFighter2 = async (port) => {
  isCOM2Connected = false;
  currentFighterPort2 = port;
  return setupFighterPort(port, 'Fighter2', SOCKET_EVENTS.COM_PORT_2_DATA);
};

// Disconnect functions
const disconnectFighter1 = () => {
  if (portCOM1 && portCOM1.isOpen) {
    portCOM1.close((err) => {
      if (err) {
        console.error('❌ ปิด Fighter1 ล้มเหลว:', err);
        logger.error(`Error closing Fighter1: ${err.message}`);
      } else {
        isCOM1Connected = false;
        portCOM1 = null;
        currentFighterPort1 = null;
        console.log('🔌 Fighter1 ตัดการเชื่อมต่อ');
      }
      updateConnectionStatus();
    });
  }
};

const disconnectFighter2 = () => {
  if (portCOM2 && portCOM2.isOpen) {
    portCOM2.close((err) => {
      if (err) {
        console.error('❌ ปิด Fighter2 ล้มเหลว:', err);
        logger.error(`Error closing Fighter2: ${err.message}`);
      } else {
        isCOM2Connected = false;
        portCOM2 = null;
        currentFighterPort2 = null;
        console.log('🔌 Fighter2 ตัดการเชื่อมต่อ');
      }
      updateConnectionStatus();
    });
  }
};

// Single interval for all ports
setInterval(() => {
  const now = Date.now();
  portStates.forEach((state, portPath) => {
    let result = {};
    const sensors = ['chest', 'stomach', 'left', 'right', 'head'];
    sensors.forEach((name) => {
      if (state.waiting[name] && now - state.lastTime[name] > SENSOR_TIMEOUT && state.buffers[name].length > 0) {
        const maxValue = Math.max(...state.buffers[name]);
        const threshold = name === 'head' ? 40 : 1500; // Changed threshold from 5 to 40
        if (maxValue >= threshold) result[name] = maxValue;
        state.buffers[name] = [];
        state.waiting[name] = false;
      }
    });
    if (Object.keys(result).length > 0) {
      console.log(`⏱️ Timeout ${portPath} max (filtered):`, result);
      io.emit(portPath === currentFighterPort1 ? SOCKET_EVENTS.COM_PORT_1_DATA : SOCKET_EVENTS.COM_PORT_2_DATA, result);
    }
  });
}, INTERVAL_CHECK);

// Routes
app.get('/', (req, res) => res.redirect('/fighters'));

app.get('/available-ports', async (req, res) => {
  try {
    const ports = await SerialPort.list();
    res.json(ports.map(p => p.path));
  } catch (err) {
    logger.error(`Error listing ports: ${err.message}`);
    res.status(500).json({ success: false, message: 'ไม่สามารถตรวจหาพอร์ตได้' });
  }
});

// Fighters CRUD
app.get('/fighters', async (req, res) => {
  try {
    const [results] = await db.pool.query('SELECT * FROM fighters');
    res.render('fighters', { fighters: results });
  } catch (err) {
    logger.error(`Error fetching fighters: ${err.message}`);
    res.status(500).send('DB Error');
  }
});

app.get('/fighters/add', (req, res) => res.render('addFighter'));

app.get('/fighters/edit/:id', async (req, res) => {
  try {
    const [results] = await db.pool.query('SELECT * FROM fighters WHERE id = ?', [req.params.id]);
    if (results.length === 0) return res.status(404).send('Not found');
    res.render('editFighter', { fighter: results[0] });
  } catch (err) {
    logger.error(`Error fetching fighter ${req.params.id}: ${err.message}`);
    res.status(404).send('Not found');
  }
});

app.post('/fighters/delete/:id', async (req, res) => {
  const fighterId = req.params.id;
  let connection;
  try {
    connection = await db.pool.getConnection();
    await connection.beginTransaction();
    const [checkResults] = await connection.query(
      'SELECT COUNT(*) AS count FROM schedulefight WHERE fighterid_1 = ? OR fighterid_2 = ?',
      [fighterId, fighterId]
    );
    if (checkResults[0].count > 0) {
      await connection.rollback();
      return res.redirect('/fighters?error=hasMatch');
    }
    await connection.query('DELETE FROM fighters WHERE id = ?', [fighterId]);
    await connection.commit();
    res.redirect('/fighters');
  } catch (err) {
    if (connection) await connection.rollback();
    logger.error(`Error deleting fighter ${fighterId}: ${err.message}`);
    res.redirect('/fighters?error=delete');
  } finally {
    if (connection) connection.release();
  }
});

app.post('/fighters/add', upload.single('photo'), async (req, res) => {
  const { name, camp, weight_class } = req.body;
  const photo = req.file ? '/uploads/' + req.file.filename : null;
  try {
    await db.pool.query(
      'INSERT INTO fighters (name, camp, weight_class, photo) VALUES (?, ?, ?, ?)',
      [name, camp, weight_class, photo]
    );
    res.redirect('/fighters');
  } catch (err) {
    logger.error(`Error adding fighter: ${err.message}`);
    res.status(500).send('Insert error');
  }
});

app.post('/fighters/edit/:id', upload.single('photo'), async (req, res) => {
  const { name, camp, weight_class } = req.body;
  const fighterId = req.params.id;
  let connection;
  try {
    connection = await db.pool.getConnection();
    await connection.beginTransaction();
    const [results] = await connection.query('SELECT photo FROM fighters WHERE id = ?', [fighterId]);
    if (results.length === 0) {
      await connection.rollback();
      return res.status(404).send('Not found');
    }
    let oldPhoto = results[0].photo;
    let newPhoto = oldPhoto;
    if (req.file) {
      newPhoto = '/uploads/' + req.file.filename;
      if (oldPhoto) {
        const oldPath = path.join(__dirname, 'public', oldPhoto);
        fs.unlink(oldPath, err => {
          if (err) logger.error(`Failed to delete old photo: ${err.message}`);
        });
      }
    }
    await connection.query(
      'UPDATE fighters SET name = ?, camp = ?, weight_class = ?, photo = ? WHERE id = ?',
      [name, camp, weight_class, newPhoto, fighterId]
    );
    await connection.commit();
    res.redirect('/fighters');
  } catch (err) {
    if (connection) await connection.rollback();
    logger.error(`Error editing fighter ${fighterId}: ${err.message}`);
    res.status(500).send('Update error');
  } finally {
    if (connection) connection.release();
  }
});

// Fights CRUD
app.get('/fights', async (req, res) => {
  const sql = `
    SELECT f.id, f.fight_date, f.description,
           a.name AS fighter1, b.name AS fighter2, w.name AS winner
    FROM fights f
    JOIN fighters a ON f.fighter1_id = a.id
    JOIN fighters b ON f.fighter2_id = b.id
    LEFT JOIN fighters w ON f.winner_id = w.id
    ORDER BY f.fight_date DESC`;
  try {
    const [results] = await db.pool.query(sql);
    res.render('fights', { fights: results });
  } catch (err) {
    logger.error(`Error fetching fights: ${err.message}`);
    res.status(500).send('DB error');
  }
});

app.get('/fights/edit/:id', async (req, res) => {
  const fightId = req.params.id;
  try {
    const [fightResults] = await db.pool.query('SELECT * FROM fights WHERE id = ?', [fightId]);
    if (fightResults.length === 0) return res.status(404).send('Not found');
    const [fighters] = await db.pool.query('SELECT * FROM fighters');
    res.render('editFight', { fight: fightResults[0], fighters });
  } catch (err) {
    logger.error(`Error fetching fight ${fightId}: ${err.message}`);
    res.status(404).send('Not found');
  }
});

app.post('/fights/edit/:id', async (req, res) => {
  const { fighter1_id, fighter2_id, winner_id, fight_date, description } = req.body;
  try {
    await db.pool.query(
      'UPDATE fights SET fighter1_id=?, fighter2_id=?, winner_id=?, fight_date=?, description=? WHERE id=?',
      [fighter1_id, fighter2_id, winner_id || null, fight_date, description, req.params.id]
    );
    res.redirect('/fights');
  } catch (err) {
    logger.error(`Error updating fight ${req.params.id}: ${err.message}`);
    res.status(500).send('Update error');
  }
});

app.post('/fights/delete/:id', async (req, res) => {
  try {
    await db.pool.query('DELETE FROM fights WHERE id = ?', [req.params.id]);
    res.redirect('/fights');
  } catch (err) {
    logger.error(`Error deleting fight ${req.params.id}: ${err.message}`);
    res.status(500).send('Delete error');
  }
});

// Fighter profile
app.get('/fighters/profile/:id', async (req, res) => {
  const fighterId = req.params.id;
  const fighterQuery = 'SELECT * FROM fighters WHERE id = ?';
  const winQuery = `
    SELECT f.fight_date, f.description, a.name AS opponent
    FROM fights f
    JOIN fighters a ON a.id = IF(f.fighter1_id = ?, f.fighter2_id, f.fighter1_id)
    WHERE f.winner_id = ?`;
  const loseQuery = `
    SELECT f.fight_date, f.description, a.name AS opponent
    FROM fights f
    JOIN fighters a ON a.id = IF(f.fighter1_id = ?, f.fighter2_id, f.fighter1_id)
    WHERE f.winner_id != ? AND (f.fighter1_id = ? OR f.fighter2_id = ?)`;
  try {
    const [fighterResult] = await db.pool.query(fighterQuery, [fighterId]);
    if (fighterResult.length === 0) return res.status(404).send('Fighter not found');
    const [wins] = await db.pool.query(winQuery, [fighterId, fighterId]);
    const [losses] = await db.pool.query(loseQuery, [fighterId, fighterId, fighterId, fighterId]);
    res.render('fighterProfile', { fighter: fighterResult[0], wins, losses });
  } catch (err) {
    logger.error(`Error fetching profile for fighter ${fighterId}: ${err.message}`);
    res.status(500).send('Profile error');
  }
});

// Match routes
app.get('/match/create', async (req, res) => {
  try {
    const [fighters] = await db.pool.query('SELECT * FROM fighters');
    res.render('createMatch', { fighters });
  } catch (err) {
    logger.error(`Error fetching fighters for match creation: ${err.message}`);
    res.status(500).send('DB error');
  }
});

app.post('/match/create', async (req, res) => {
  const { fighter1_id, fighter2_id, fight_date } = req.body;
  if (!isCOM1Connected || !isCOM2Connected) {
    return res.status(400).send('Bluetooth devices not connected');
  }
  try {
    await db.pool.query(
      'INSERT INTO schedulefight (fighterid_1, fighterid_2, fight_date) VALUES (?, ?, ?)',
      [fighter1_id, fighter2_id, fight_date]
    );
    res.redirect('/match');
  } catch (err) {
    logger.error(`Error creating match: ${err.message}`);
    res.status(500).send('Create match failed');
  }
});

app.get('/match', async (req, res) => {
  try {
    // ดึงข้อมูลการแข่งขัน
    const [fights] = await db.pool.query(`
      SELECT s.id, s.fight_date, f1.name AS fighter1, f2.name AS fighter2
      FROM schedulefight s
      JOIN fighters f1 ON s.fighterid_1 = f1.id
      JOIN fighters f2 ON s.fighterid_2 = f2.id
      ORDER BY s.fight_date ASC, s.id ASC
    `);

    // ดึงวันที่ที่มีในฐานข้อมูล
    const [distinctDates] = await db.pool.query(`
      SELECT DISTINCT fight_date
      FROM schedulefight
      ORDER BY fight_date ASC
    `);

    // เพิ่ม matchCount และแปลงวันที่
    let currentDate = null;
    let matchCount = 0;
    const fightsWithCount = fights.map(fight => {
      const fightDate = fight.fight_date.toISOString().split('T')[0]; // YYYY-MM-DD
      if (fightDate !== currentDate) {
        currentDate = fightDate;
        matchCount = 1;
      } else {
        matchCount++;
      }
      return { ...fight, matchCount, fightDate };
    });

    // แปลง distinctDates เป็น array ของ YYYY-MM-DD
    const availableDates = distinctDates.map(row => row.fight_date.toISOString().split('T')[0]);

    res.render('matchSchedule', { fights: fightsWithCount, availableDates });
  } catch (err) {
    logger.error(`Error fetching match schedule: ${err.message}`);
    res.status(500).send('เกิดข้อผิดพลาดในการดึงข้อมูลการแข่งขัน');
  }
});

app.get('/fights/data/:id', async (req, res) => {
  const id = req.params.id;
  const sqlSchedulefight = `
    SELECT s.id, s.fighterid_1, s.fighterid_2,
           a.name AS fighter1_name, a.camp AS fighter1_camp, a.weight_class AS fighter1_weight, a.photo AS fighter1_photo,
           b.name AS fighter2_name, b.camp AS fighter2_camp, b.weight_class AS fighter2_weight, b.photo AS fighter2_photo
    FROM schedulefight s
    JOIN fighters a ON s.fighterid_1 = a.id
    JOIN fighters b ON s.fighterid_2 = b.id
    WHERE s.id = ?`;
  const sqlFighters = `SELECT id, name FROM fighters`;
  const sqlDatafight = `
    SELECT id, clipdetail, clipdetail2, fighterdetail, time, timehit, fighterid, round
    FROM datafight
    WHERE schedulefight_id = ?
    ORDER BY round ASC, id ASC`;
  const sqlMaxRound = `
    SELECT MAX(round) AS maxRound 
    FROM datafight 
    WHERE schedulefight_id = ?`;
  try {
    const [results] = await db.pool.query(sqlSchedulefight, [id]);
    if (results.length === 0) return res.status(404).send('ไม่พบข้อมูล');
    const row = results[0];
    const fighter1 = {
      name: row.fighter1_name,
      camp: row.fighter1_camp,
      weight_class: row.fighter1_weight,
      photo: row.fighter1_photo
    };
    const fighter2 = {
      name: row.fighter2_name,
      camp: row.fighter2_camp,
      weight_class: row.fighter2_weight,
      photo: row.fighter2_photo
    };
    const [fightersList] = await db.pool.query(sqlFighters);
    const [datafightResults] = await db.pool.query(sqlDatafight, [id]);
    const [roundResult] = await db.pool.query(sqlMaxRound, [id]);
    const fighterIdNameMap = {};
    fightersList.forEach(f => fighterIdNameMap[f.id] = f.name);
    const groupedByRound = {};
    datafightResults.forEach(item => {
      const round = item.round || 1;
      if (!groupedByRound[round]) groupedByRound[round] = [];
      groupedByRound[round].push(item);
    });
    const maxRound = roundResult[0].maxRound || 0;
    res.render('datafight', {
      fighter1,
      fighter2,
      schedulefightId: row.id,
      fightDataGrouped: groupedByRound,
      fighterIdNameMap,
      roundNumberStart: maxRound + 1
    });
  } catch (err) {
    logger.error(`Error fetching fight data ${id}: ${err.message}`);
    res.status(500).send('เกิดข้อผิดพลาดในการดึงข้อมูล');
  }
});

app.post('/match/summary', async (req, res) => {
  const { schedulefightId } = req.body;
  if (!Number.isInteger(Number(schedulefightId))) {
    return res.json({ success: false, message: 'schedulefightId ต้องเป็นตัวเลข' });
  }
  const sql = `
    SELECT id, clipdetail, clipdetail2, fighterdetail, time, timehit, fighterid, round
    FROM datafight
    WHERE schedulefight_id = ?
    ORDER BY round ASC, id ASC`;
  try {
    const [results] = await db.pool.query(sql, [schedulefightId]);
    if (results.length === 0) return res.json({ success: false, message: 'ไม่มีข้อมูลการแข่งขัน' });
    const fighterIds = [...new Set(results.map(r => r.fighterid))];
    const [fighters] = await db.pool.query('SELECT id, name FROM fighters WHERE id IN (?)', [fighterIds]);
    const fighterMap = {};
    fighters.forEach(f => fighterMap[f.id] = f.name);
    const summaryByRound = [];
    const rounds = [...new Set(results.map(r => r.round))];
    rounds.forEach(round => {
      const roundData = results.filter(r => r.round === round);
      const scores = {};
      const details = {};
      fighterIds.forEach(fid => {
        scores[fid] = { body: 0, head: 0, fall: 0, total: 0 };
        details[fid] = { bodyHits: [], headHits: [], fallHits: [] };
      });
      roundData.forEach(r => {
        const fid = r.fighterid;
        if (r.fighterdetail.includes('fall')) {
          scores[fid].fall += 1;
          scores[fid].total += 3;
          details[fid].fallHits.push(r.fighterdetail);
        } else if (r.fighterdetail.includes('head')) {
          scores[fid].head += 1;
          scores[fid].total += 2;
          details[fid].headHits.push(r.fighterdetail);
        } else if (r.fighterdetail.includes('chest') || r.fighterdetail.includes('stomach') || 
                   r.fighterdetail.includes('left') || r.fighterdetail.includes('right')) {
          scores[fid].body += 1;
          scores[fid].total += 1;
          details[fid].bodyHits.push(r.fighterdetail);
        }
      });
      const [fighter1Id, fighter2Id] = fighterIds;
      const winnerId = scores[fighter1Id].total > scores[fighter2Id].total ? fighter1Id :
                       scores[fighter2Id].total > scores[fighter1Id].total ? fighter2Id : null;
      summaryByRound.push({
        round,
        scores: {
          [fighter1Id]: scores[fighter1Id],
          [fighter2Id]: scores[fighter2Id]
        },
        details: {
          [fighter1Id]: details[fighter1Id],
          [fighter2Id]: details[fighter2Id]
        },
        winnerId
      });
    });
    // Calculate overall winner
    let winCount = {};
    fighterIds.forEach(fid => winCount[fid] = 0);
    summaryByRound.forEach(r => {
      if (r.winnerId) winCount[r.winnerId]++;
    });
    const [fid1, fid2] = fighterIds;
    const overallWinnerId = winCount[fid1] > winCount[fid2] ? fid1 :
                            winCount[fid2] > winCount[fid1] ? fid2 : null;
    res.json({
      success: true,
      summaryByRound,
      fighters: { [fid1]: fighterMap[fid1], [fid2]: fighterMap[fid2] },
      overallWinnerId
    });
  } catch (err) {
    logger.error(`Error fetching match summary ${schedulefightId}: ${err.message}`);
    res.json({ success: false, message: 'ดึงข้อมูลล้มเหลว' });
  }
});

app.get('/connectCOM', (req, res) => res.render('connectCOM'));

app.post('/upload-video', upload.single('video'), (req, res) => {
  if (!req.file) return res.status(400).json({ success: false, message: 'No video uploaded' });
  const videoPath = '/uploads/' + req.file.filename;
  res.json({ success: true, url: videoPath });
});

app.post('/datafight/save', async (req, res) => {
  const { schedulefight_id, clip_url, clip_url2, data, time, round } = req.body;
  if (!data || data.length === 0) {
    logger.error('No data provided for datafight save');
    return res.status(400).json({ success: false, message: 'ไม่มีข้อมูล' });
  }
  let connection;
  try {
    connection = await db.pool.getConnection();
    await connection.beginTransaction();
    const [results] = await connection.query('SELECT fighterid_1, fighterid_2 FROM schedulefight WHERE id = ?', [schedulefight_id]);
    if (results.length === 0) {
      throw new Error('ไม่พบ schedulefight');
    }
    const fighter1 = results[0].fighterid_1;
    const fighter2 = results[0].fighterid_2;
    const insertData = [];
    data.forEach(d => {
      let fighterid = d.label.includes('นักชก1') ? fighter1 : d.label.includes('นักชก2') ? fighter2 : null;
      if (!fighterid) return;
      let details = d.value;
      let timeHitSeconds = 0;
      if (details.includes('|')) {
        const parts = details.split('|');
        details = parts[0];
        timeHitSeconds = parseInt(parts[1], 10);
      }
      const timehit = secondsToTime(timeHitSeconds);
      const fighterDetail = d.fighterdetail || `${d.label} ${details}${d.position ? ' ' + d.position : ''}`;
      insertData.push([time, fighterid, fighterDetail, clip_url, schedulefight_id, timehit, round, clip_url2]);
    });
    if (insertData.length === 0) {
      throw new Error('ไม่มีข้อมูลให้บันทึก');
    }
    await connection.query(
      'INSERT INTO datafight (time, fighterid, fighterdetail, clipdetail, schedulefight_id, timehit, round, clipdetail2) VALUES ?',
      [insertData]
    );
    await connection.commit();
    console.log('✅ บันทึกข้อมูลสำเร็จ:', { affectedRows: insertData.length });
    res.json({ success: true });
  } catch (err) {
    if (connection) await connection.rollback();
    logger.error(`Error saving datafight for schedulefight ${schedulefight_id}: ${err.message}`);
    res.status(500).json({ success: false, message: 'บันทึกข้อมูลล้มเหลว' });
  } finally {
    if (connection) connection.release();
  }
});

const secondsToTime = (sec) => {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return [h, m, s].map(v => v.toString().padStart(2, '0')).join(':');
};

app.get('/replay', (req, res) => res.render('replay'));

app.post('/match/delete/:id', async (req, res) => {
  const id = req.params.id;
  let connection;
  try {
    connection = await db.pool.getConnection();
    await connection.beginTransaction();
    await connection.query('DELETE FROM datafight WHERE schedulefight_id = ?', [id]);
    await connection.query('DELETE FROM schedulefight WHERE id = ?', [id]);
    await connection.commit();
    res.redirect('/match');
  } catch (err) {
    if (connection) await connection.rollback();
    logger.error(`Error deleting match ${id}: ${err.message}`);
    res.status(500).send('เกิดข้อผิดพลาดในการลบ match');
  } finally {
    if (connection) connection.release();
  }
});

// Socket.IO
io.on('connection', (socket) => {
  console.log('Client connected');
  updateConnectionStatus();
  socket.on('requestConnectionStatus', () => {
    updateConnectionStatus();
  });
  // เชื่อมต่อเฉพาะ Fighter 1
socket.on('connectFighter1', async ({ port }) => {
  console.log(`🔌 เชื่อมต่อเฉพาะ Fighter 1: ${port}`);
  try {
    const ports = await SerialPort.list();
    if (!ports.some(p => p.path === port)) {
      throw new Error(`พอร์ต ${port} ไม่พบ`);
    }
    if (port === currentFighterPort2) {
      throw new Error(`พอร์ต ${port} ถูกใช้โดย Fighter 2 อยู่`);
    }

    // ปิดเฉพาะ Fighter 1 ถ้ามีการเชื่อมต่อเก่า
    disconnectFighter1();

    portCOM1 = await setupFighter1(port);
    currentFighterPort1 = port;
    isCOM1Connected = true;

    updateConnectionStatus();
    socket.emit('connectionStatus', {
      fighterPort1: currentFighterPort1,
      fighterPort2: currentFighterPort2
    });

  } catch (err) {
    console.error(`❌ เชื่อมต่อ Fighter 1 ล้มเหลว: ${err.message}`);
    socket.emit(SOCKET_EVENTS.CONNECTION_ERROR, `Fighter 1: ${err.message}`);
    updateConnectionStatus();
  }
});

// เชื่อมต่อเฉพาะ Fighter 2
socket.on('connectFighter2', async ({ port }) => {
  console.log(`🔌 เชื่อมต่อเฉพาะ Fighter 2: ${port}`);
  try {
    const ports = await SerialPort.list();
    if (!ports.some(p => p.path === port)) {
      throw new Error(`พอร์ต ${port} ไม่พบ`);
    }
    if (port === currentFighterPort1) {
      throw new Error(`พอร์ต ${port} ถูกใช้โดย Fighter 1 อยู่`);
    }

    disconnectFighter2();

    portCOM2 = await setupFighter2(port);
    currentFighterPort2 = port;
    isCOM2Connected = true;

    updateConnectionStatus();
    socket.emit('connectionStatus', {
      fighterPort1: currentFighterPort1,
      fighterPort2: currentFighterPort2
    });

  } catch (err) {
    console.error(`❌ เชื่อมต่อ Fighter 2 ล้มเหลว: ${err.message}`);
    socket.emit(SOCKET_EVENTS.CONNECTION_ERROR, `Fighter 2: ${err.message}`);
    updateConnectionStatus();
  }
});

// ปรับ event connectCOMPorts เดิมให้รองรับกรณีส่งทั้งคู่ (optional fallback)
socket.on('connectCOMPorts', async ({ fighterPort1, fighterPort2 }) => {
  // ถ้าส่งทั้งคู่ → เรียกแยกตามลำดับ (แต่แนะนำให้ client ใช้ event แยกแทน)
  if (fighterPort1) {
    socket.emit('connectFighter1', { port: fighterPort1 });
  }
  if (fighterPort2) {
    socket.emit('connectFighter2', { port: fighterPort2 });
  }
});

  socket.on('disconnectCOMPorts', () => {
    console.log('🔌 ตัดการเชื่อมต่อทั้งหมด');
    disconnectFighter1();
    disconnectFighter2();
    isCOM1Connected = false;
    isCOM2Connected = false;
    updateConnectionStatus();
  });
  socket.on('disconnect', () => {
    console.log('Client disconnected');
  });

  // ตัดการเชื่อมต่อเฉพาะ Fighter 1
  socket.on('disconnectFighter1', () => {
    console.log('🔌 รับคำสั่งตัดการเชื่อมต่อ Fighter 1');
    disconnectFighter1();
    updateConnectionStatus();
  });

  // ตัดการเชื่อมต่อเฉพาะ Fighter 2
  socket.on('disconnectFighter2', () => {
    console.log('🔌 รับคำสั่งตัดการเชื่อมต่อ Fighter 2');
    disconnectFighter2();
    updateConnectionStatus();
  });
});

// Cleanup on server shutdown
let isCleaningUp = false;
const cleanup = () => {
  if (isCleaningUp) return;
  isCleaningUp = true;
  console.log('🛑 ปิด server...');
  if (portCOM1 && portCOM1.isOpen) disconnectFighter1();
  if (portCOM2 && portCOM2.isOpen) disconnectFighter2();
  db.close().then(() => {
    console.log('📚 ปิดการเชื่อมต่อฐานข้อมูล');
    server.close(() => {
      console.log('🚪 Server ปิดแล้ว');
      process.exit(0);
    });
  }).catch(err => {
    console.error('❌ ข้อผิดพลาดตอนปิด:', err.message);
    logger.error(`Error during cleanup: ${err.message}`);
    process.exit(1);
  });
};

process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);

server.listen(3000, () => console.log('🚀 Server รันที่ http://localhost:3000'));