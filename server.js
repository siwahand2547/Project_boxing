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
const { COM_PORT_1, COM_PORT_2, BAUD_RATE, SENSOR_TIMEOUT, INTERVAL_CHECK, SOCKET_EVENTS, LOG_FILE } = config;

// Logger setup
const logger = winston.createLogger({
  level: 'info',
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
let currentFighterPort1 = null;
let currentFighterPort2 = null;
const portStates = new Map();

// Update connection status
const updateConnectionStatus = () => {
  const status = {
    port1: currentFighterPort1,
    connected1: isCOM1Connected,
    port2: currentFighterPort2,
    connected2: isCOM2Connected
  };
  io.emit(SOCKET_EVENTS.CONNECTION_STATUS, status);
};

// Process sensor data (เกณฑ์ 4000, ไม่มีการตรวจสอบค่าเกิน 4095)
const processSensorData = (rawData, portName, state, emitEvent) => {
  console.log(`📥 ข้อมูลดิบจาก ${portName}: ${rawData}`);
  const parts = rawData.split(',').map(v => parseInt(v.trim(), 10));
  if (parts.length !== 4 || parts.some(isNaN)) {
    console.error(`🚫 ข้อมูลไม่ถูกต้องจาก ${portName}: ${rawData}`);
    logger.error(`ข้อมูลไม่ถูกต้องจาก ${portName}: ${rawData}`);
    return;
  }
  const [chestVal, stomachVal, leftVal, rightVal] = parts;
  const now = Date.now();
  let result = {};
  const sensors = [
    { name: 'chest', value: chestVal },
    { name: 'stomach', value: stomachVal },
    { name: 'left', value: leftVal },
    { name: 'right', value: rightVal }
  ];
  sensors.forEach(({ name, value }) => {
    if (value >= 1500) { // เก็บค่า >= 4000 เข้า buffer
      state.buffers[name].push(value);
      state.waiting[name] = true;
      state.lastTime[name] = now;
    } else if (state.waiting[name] && state.buffers[name].length > 0) {
      const maxValue = Math.max(...state.buffers[name]);
      if (maxValue >= 1500) result[name] = maxValue; // ส่งค่าสูงสุด
      state.buffers[name] = [];
      state.waiting[name] = false;
    }
  });
  if (Object.keys(result).length > 0) {
    // เพิ่มเงื่อนไข: ถ้ามีหลาย key ใน result และค่าทั้งหมดเท่ากัน ให้เลือกเฉพาะ key ตัวล่าสุดที่เข้ามา (right > left > stomach > chest) และล้าง buffer ทุกตัวเพื่อป้องกันค่าค้างซ้ำ
    if (Object.keys(result).length > 1) {
      const values = Object.values(result);
      const firstValue = values[0];
      const allEqual = values.every(v => v === firstValue);
      if (allEqual) {
        // ลำดับ reverse เพื่อหาตัวล่าสุด: right > left > stomach > chest
        const sensorsOrder = ['right', 'left', 'stomach', 'chest'];
        const lastKey = sensorsOrder.find(name => result[name]);
        result = { [lastKey]: result[lastKey] };
        console.log(`⚠️ ค่าหลาย sensor เท่ากัน เลือกเฉพาะตัวล่าสุด ${lastKey}: ${result[lastKey]}`);
        // ล้าง buffer ทุก sensor เพื่อป้องกันค่าค้างซ้ำ
        sensors.forEach(({ name }) => {
          state.buffers[name] = [];
          state.waiting[name] = false;
        });
      }
    }

    console.log(`✅ ส่งข้อมูล ${portName}: ${JSON.stringify(result)}`);
    io.emit(emitEvent, result);
  }
};

// Setup serial port with retry
const setupFighterPort = (portPath, portName, emitEvent, maxRetries = 3) => {
  let retryCount = 0;
  const tryConnect = () => {
    return new Promise((resolve) => {
      console.log(`🔌 พยายามเชื่อมต่อ ${portName} (${portPath})`);
      const port = new SerialPort({ path: portPath, baudRate: BAUD_RATE }, (err) => {
        if (err) {
          console.error(`❌ ล้มเหลว ${portName}: ${err.message}`);
          logger.error(`ล้มเหลว ${portName}: ${err.message}`);
          if (retryCount < maxRetries) {
            retryCount++;
            console.log(`🔄 ลองใหม่ ${portName} (${retryCount}/${maxRetries})`);
            setTimeout(tryConnect, 2000);
            return;
          }
          console.log(`🚫 ไม่สามารถเชื่อมต่อ ${portName} (${portPath}) หลัง ${maxRetries} ครั้ง`);
          io.emit(SOCKET_EVENTS.CONNECTION_ERROR, `ไม่สามารถเชื่อมต่อ ${portName} (${portPath}): ${err.message}`);
          if (portName === 'Fighter1') isCOM1Connected = false;
          else isCOM2Connected = false;
          updateConnectionStatus();
          resolve(null);
        } else {
          console.log(`✅ เชื่อมต่อ ${portName} สำเร็จ`);
          if (portName === 'Fighter1') isCOM1Connected = true;
          else isCOM2Connected = true;
          portStates.set(portPath, {
            buffers: { chest: [], stomach: [], left: [], right: [] },
            waiting: { chest: false, stomach: false, left: false, right: false },
            lastTime: { chest: Date.now(), stomach: Date.now(), left: Date.now(), right: Date.now() }
          });
          updateConnectionStatus();
          resolve(port);

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
            console.error(`❌ ข้อผิดพลาด ${portName}: ${err.message}`);
            io.emit(SOCKET_EVENTS.CONNECTION_ERROR, `ข้อผิดพลาด ${portName}: ${err.message}`);
            updateConnectionStatus();
          });
        }
      });
    });
  };
  return tryConnect();
};

// Setup for Fighter 1
const setupFighter1 = async (port) => {
  isCOM1Connected = false;
  return setupFighterPort(port, 'Fighter1', SOCKET_EVENTS.COM_PORT_1_DATA);
};

// Setup for Fighter 2
const setupFighter2 = async (port) => {
  isCOM2Connected = false;
  return setupFighterPort(port, 'Fighter2', SOCKET_EVENTS.COM_PORT_2_DATA);
};

// Disconnect functions
const disconnectFighter1 = () => {
  if (portCOM1 && portCOM1.isOpen) {
    portCOM1.close((err) => {
      if (err) console.error('❌ ปิด Fighter1 ล้มเหลว:', err);
      else {
        isCOM1Connected = false;
        portCOM1 = null;
        console.log('🔌 Fighter1 ตัดการเชื่อมต่อ');
      }
      updateConnectionStatus();
    });
  }
};

const disconnectFighter2 = () => {
  if (portCOM2 && portCOM2.isOpen) {
    portCOM2.close((err) => {
      if (err) console.error('❌ ปิด Fighter2 ล้มเหลว:', err);
      else {
        isCOM2Connected = false;
        portCOM2 = null;
        console.log('🔌 Fighter2 ตัดการเชื่อมต่อ');
      }
      updateConnectionStatus();
    });
  }
};

// Single interval for all ports (ส่งค่าสูงสุด, ไม่มีการตรวจสอบค่าเกิน 4095)
setInterval(() => {
  const now = Date.now();
  portStates.forEach((state, portPath) => {
    let result = {};
    const sensors = ['chest', 'stomach', 'left', 'right'];
    sensors.forEach((name) => {
      if (state.waiting[name] && now - state.lastTime[name] > SENSOR_TIMEOUT && state.buffers[name].length > 0) {
        const maxValue = Math.max(...state.buffers[name]);
        if (maxValue >= 1500) result[name] = maxValue; // ส่งค่าสูงสุด
        state.buffers[name] = [];
        state.waiting[name] = false;
      }
    });
    if (Object.keys(result).length > 0) {
      // เพิ่มเงื่อนไข: ถ้ามีหลาย key ใน result และค่าทั้งหมดเท่ากัน ให้เลือกเฉพาะ key ตัวล่าสุดที่เข้ามา (right > left > stomach > chest) และล้าง buffer ทุกตัวเพื่อป้องกันค่าค้างซ้ำ
      if (Object.keys(result).length > 1) {
        const values = Object.values(result);
        const firstValue = values[0];
        const allEqual = values.every(v => v === firstValue);
        if (allEqual) {
          // ลำดับ reverse เพื่อหาตัวล่าสุด: right > left > stomach > chest
          const sensorsOrder = ['right', 'left', 'stomach', 'chest'];
          const lastKey = sensorsOrder.find(name => result[name]);
          result = { [lastKey]: result[lastKey] };
          console.log(`⚠️ ค่าหลาย sensor เท่ากัน เลือกเฉพาะตัวล่าสุด ${lastKey}: ${result[lastKey]}`);
          // ล้าง buffer ทุก sensor เพื่อป้องกันค่าค้างซ้ำ
          sensors.forEach((name) => {
            state.buffers[name] = [];
            state.waiting[name] = false;
          });
        }
      }

      console.log(`✅ ส่งข้อมูล ${portPath}: ${JSON.stringify(result)}`);
      io.emit(portPath === currentFighterPort1 ? SOCKET_EVENTS.COM_PORT_1_DATA : SOCKET_EVENTS.COM_PORT_2_DATA, result);
    }
  });
}, INTERVAL_CHECK);

// Routes (คงเดิม)
app.get('/', (req, res) => res.redirect('/fighters'));

app.get('/available-ports', async (req, res) => {
  const maxRetries = 3;
  let retryCount = 0;
  while (retryCount < maxRetries) {
    try {
      const ports = await SerialPort.list();
      console.log(`📋 พอร์ตที่มี: ${JSON.stringify(ports.map(p => p.path))}`);
      res.json(ports.map(p => p.path));
      return;
    } catch (err) {
      retryCount++;
      console.error(`❌ ตรวจสอบพอร์ตล้มเหลว (ครั้งที่ ${retryCount}/${maxRetries}): ${err.message}`);
      logger.error(`ตรวจสอบพอร์ตล้มเหลว (ครั้งที่ ${retryCount}/${maxRetries}): ${err.message}`);
      if (retryCount === maxRetries) {
        res.status(500).json({ success: false, message: 'ไม่สามารถตรวจหาพอร์ตได้' });
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
});

app.get('/default-ports', (req, res) => {
  res.json({ comPort1: COM_PORT_1, comPort2: COM_PORT_2 });
});

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
  const sql = `
    SELECT s.id, s.fight_date, f1.name AS fighter1, f2.name AS fighter2
    FROM schedulefight s
    JOIN fighters f1 ON s.fighterid_1 = f1.id
    JOIN fighters f2 ON s.fighterid_2 = f2.id
    ORDER BY s.fight_date ASC`;
  try {
    const [fights] = await db.pool.query(sql);
    res.render('matchSchedule', { fights });
  } catch (err) {
    logger.error(`Error fetching matches: ${err.message}`);
    res.status(500).send('DB error');
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
      roundData.forEach(r => scores[r.fighterid] = r.hits || 0);
      const [fighter1Id, fighter2Id] = fighterIds;
      const score1 = scores[fighter1Id] || 0;
      const score2 = scores[fighter2Id] || 0;
      let winnerId = score1 > score2 ? fighter1Id : score2 > score1 ? fighter2Id : null;
      summaryByRound.push({ round, scores: { [fighter1Id]: score1, [fighter2Id]: score2 }, winnerId });
    });
    res.json({
      success: true,
      summaryByRound,
      fighters: { [fighterIds[0]]: fighterMap[fighterIds[0]], [fighterIds[1]]: fighterMap[fighterIds[1]] }
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
  updateConnectionStatus();
  socket.on('requestConnectionStatus', () => {
    updateConnectionStatus();
  });
  socket.on('connectCOMPorts', async ({ fighterPort1, fighterPort2 }) => {
    console.log(`🔌 รับคำสั่งเชื่อมต่อ: ${fighterPort1}, ${fighterPort2}`);
    try {
      const ports = await SerialPort.list();
      const portNames = ports.map(p => p.path);
      if (!portNames.includes(fighterPort1)) throw new Error(`พอร์ต ${fighterPort1} ไม่มี`);
      if (!portNames.includes(fighterPort2)) throw new Error(`พอร์ต ${fighterPort2} ไม่มี`);
      if (fighterPort1 === fighterPort2) throw new Error('พอร์ตต้องไม่ซ้ำ');
      disconnectFighter1();
      disconnectFighter2();
      currentFighterPort1 = fighterPort1;
      currentFighterPort2 = fighterPort2;
      portCOM1 = await setupFighter1(fighterPort1);
      portCOM2 = await setupFighter2(fighterPort2);
      updateConnectionStatus();
    } catch (err) {
      console.error(`❌ ข้อผิดพลาดการเชื่อมต่อ: ${err.message}`);
      logger.error(`ข้อผิดพลาดการเชื่อมต่อ: ${err.message}`);
      socket.emit(SOCKET_EVENTS.CONNECTION_ERROR, err.message);
      updateConnectionStatus();
    }
  });
  socket.on('swapCOMPorts', async () => {
    console.log('🔄 สลับพอร์ต');
    try {
      const tempPort1 = currentFighterPort1;
      const tempPort2 = currentFighterPort2;
      currentFighterPort1 = tempPort2;
      currentFighterPort2 = tempPort1;
      disconnectFighter1();
      disconnectFighter2();
      if (currentFighterPort1) portCOM1 = await setupFighter1(currentFighterPort1);
      if (currentFighterPort2) portCOM2 = await setupFighter2(currentFighterPort2);
      updateConnectionStatus();
    } catch (err) {
      console.error(`❌ ข้อผิดพลาดการสลับพอร์ต: ${err.message}`);
      logger.error(`ข้อผิดพลาดการสลับพอร์ต: ${err.message}`);
      socket.emit(SOCKET_EVENTS.CONNECTION_ERROR, err.message);
      updateConnectionStatus();
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
    logger.error(`ข้อผิดพลาดตอนปิด: ${err.message}`);
    process.exit(1);
  });
};

process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);

server.listen(3000, () => console.log('🚀 Server รันที่ http://localhost:3000'));