const db = require('../db');

exports.getUsers = (req, res) => {
  db.query('SELECT * FROM users', (err, results) => {
    if (err) {
      console.error(err);
      res.status(500).send('Server error');
      return;
    }
    res.json(results);
  });
};

exports.createUser = (req, res) => {
  const { name, email } = req.body;
  db.query('INSERT INTO users (name, email) VALUES (?, ?)', [name, email], err => {
    if (err) {
      console.error(err);
      res.status(500).send('Server error');
      return;
    }
    res.send('User created');
  });
};

exports.updateUser = (req, res) => {
  const { id } = req.params;
  const { name, email } = req.body;
  db.query('UPDATE users SET name=?, email=? WHERE id=?', [name, email, id], err => {
    if (err) {
      console.error(err);
      res.status(500).send('Server error');
      return;
    }
    res.send('User updated');
  });
};

exports.deleteUser = (req, res) => {
  const { id } = req.params;
  db.query('DELETE FROM users WHERE id=?', [id], err => {
    if (err) {
      console.error(err);
      res.status(500).send('Server error');
      return;
    }
    res.send('User deleted');
  });
};
