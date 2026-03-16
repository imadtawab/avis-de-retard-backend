const express    = require('express');
const cors       = require('cors');
const nodemailer = require('nodemailer');
const multer     = require('multer');
const mongoose   = require('mongoose');
require('dotenv').config();

const app  = express();
const PORT = 3600;

app.use(cors());
app.use(express.json());

/* ── Mongoose Schemas ── */
const clientSchema = new mongoose.Schema({
  name:   { type: String, required: true, trim: true },
  emails: { type: [String], default: [] }
})

const truckSchema = new mongoose.Schema({
  refTruck:        { type: String, required: true, trim: true },
  matricule:       { type: String, required: true, trim: true },
  selectedClients: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Client' }]
})

const Client = mongoose.model('Client', clientSchema)
const Truck  = mongoose.model('Truck',  truckSchema)

/* ── MongoDB ── */
mongoose.connect(process.env.DB)
  .then(() => console.log('Connecté à MongoDB'))
  .catch(err => console.error('Erreur MongoDB :', err.message))

/* ── Nodemailer ── */
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.MAIL_ADRESSE,
    pass: process.env.MAIL_PASSWORD
  }
})

/* ── Multer ── */
const upload = multer({ storage: multer.memoryStorage() })

/* ─────────────────────────────────────────────
   CLIENTS
───────────────────────────────────────────── */

app.get('/api/clients', async (req, res) => {
  try {
    const clients = await Client.find().lean()
    res.json(clients)
  } catch (err) {
    console.error('Erreur GET /api/clients :', err)
    res.status(500).json({ error: 'Erreur serveur' })
  }
})

app.get('/api/clients/:id', async (req, res) => {
  try {
    const client = await Client.findById(req.params.id).lean()
    if (!client) return res.status(404).json({ error: 'Client introuvable' })
    res.json(client)
  } catch (err) {
    console.error('Erreur GET /api/clients/:id :', err)
    res.status(500).json({ error: 'Erreur serveur' })
  }
})

app.post('/api/clients/new', async (req, res) => {
  try {
    const { name, emails } = req.body
    if (!name?.trim())              return res.status(400).json({ error: 'Le nom est requis.' })
    if (!emails?.length)            return res.status(400).json({ error: 'Au moins un email est requis.' })

    const client = await Client.create({ name: name.trim(), emails })
    res.status(201).json(client)
  } catch (err) {
    console.error('Erreur POST /api/clients/new :', err)
    res.status(500).json({ error: 'Erreur serveur' })
  }
})

/* ─────────────────────────────────────────────
   TRUCKS
───────────────────────────────────────────── */

app.get('/api/trucks', async (req, res) => {
  try {
    // populate résout automatiquement les références
    const trucks = await Truck.find().populate('selectedClients').lean()
    res.json(trucks)
  } catch (err) {
    console.error('Erreur GET /api/trucks :', err)
    res.status(500).json({ error: 'Erreur serveur' })
  }
})

app.post('/api/trucks/new', async (req, res) => {
  try {
    const { refTruck, matricule, clientIds } = req.body
    if (!refTruck?.trim() || !matricule?.trim())
      return res.status(400).json({ error: 'Référence et matricule requis.' })

    const truck = await Truck.create({
      refTruck:        refTruck.trim(),
      matricule:       matricule.trim(),
      selectedClients: clientIds ?? []
    })

    // Retourner avec les clients populés
    const populated = await truck.populate('selectedClients')
    res.status(201).json(populated)
  } catch (err) {
    console.error('Erreur POST /api/trucks/new :', err)
    res.status(500).json({ error: 'Erreur serveur' })
  }
})

/* ─────────────────────────────────────────────
   SEND EMAIL (SSE)
───────────────────────────────────────────── */

app.post('/api/send-email', upload.array('attachments'), async (req, res) => {
  const body    = req.body
  const trucks  = typeof body.trucks === 'string' ? JSON.parse(body.trucks) : body.trucks
  const objet   = body.objet
  const message = body.message

  if (!trucks || !objet || !message)
    return res.status(400).json({ error: 'trucks, objet et message sont requis.' })

  const attachments = (req.files || []).map(f => ({
    filename:    f.originalname,
    content:     f.buffer,
    contentType: f.mimetype
  }))

  res.setHeader('Content-Type',  'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection',    'keep-alive')
  res.flushHeaders()

  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`)

  try {
    for (const truck of trucks) {
      send({ type: 'truck_start', truck: { matricule: truck.matricule, refTruck: truck.refTruck } })

      for (const client of (truck.selectedClients ?? [])) {
        if (!Array.isArray(client.emails) || client.emails.length === 0) {
          send({ type: 'client_skip', client: client.name, matricule: truck.matricule, reason: 'Aucun email' })
          continue
        }

        send({ type: 'client_sending', client: client.name, matricule: truck.matricule })

        await transporter.sendMail({
          from:        process.env.MAIL_ADRESSE,
          to:          client.emails.join(', '),
          cc:          process.env.MAIL_ADRESSE_CC,
          subject:     `${objet} — ${client.name} | ${truck.matricule} / ${truck.refTruck}`.toUpperCase(),
          text:        message,
          attachments
        })

        send({ type: 'client_done', client: client.name, matricule: truck.matricule, emails: client.emails })
      }

      send({ type: 'truck_done', truck: { matricule: truck.matricule, refTruck: truck.refTruck } })
    }

    send({ type: 'finished' })
    res.end()

  } catch (err) {
    send({ type: 'error', message: err.message })
    res.end()
  }
})

app.listen(PORT, () => console.log(`Serveur sur http://localhost:${PORT}`))