const express = require('express');
const cors = require('cors');
const fs = require('fs');

const app = express();
const PORT = 3001;

// Enable CORS so frontend on another port can access this API
app.use(cors());

// Load JSON data files
const experience = JSON.parse(fs.readFileSync('./data/experience.json', 'utf8'));
const skills = JSON.parse(fs.readFileSync('./data/skills.json', 'utf8'));
const projects = JSON.parse(fs.readFileSync('./data/projects.json', 'utf8'));

// Health endpoint
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Experience endpoint
app.get('/api/experience', (req, res) => {
  res.json(experience);
});

// Skills endpoint
app.get('/api/skills', (req, res) => {
  res.json(skills);
});

// Projects endpoint
app.get('/api/projects', (req, res) => {
  res.json(projects);
});

// Start the server
app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});