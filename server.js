const express    = require('express');
const cors       = require('cors');
const nodemailer = require('nodemailer');
const multer     = require('multer');
const path       = require('path');
const { MongoClient, ObjectId } = require('mongodb');

const app  = express();
const PORT = 3600;

/* ── Middleware ── */
app.use(cors());
app.use(express.json());
require('dotenv').config(); 

/* ── MongoDB ── */
const uri    = 'mongodb://localhost:27017/avis_de_retard';
const mongo  = new MongoClient(uri);
let clientsCol, trucksCol;

async function connectDB() {
  try {
    await mongo.connect();
    console.log('Connecté à MongoDB');
    const db   = mongo.db('avis_de_retard');
    clientsCol = db.collection('clients');
    trucksCol  = db.collection('trucks');
  } catch (err) {
    console.error('Erreur de connexion MongoDB :', err);
    process.exit(1);
  }
}

connectDB();

/* ── Nodemailer ── */
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.MAIL_ADRESSE,
    pass: process.env.MAIL_PASSWORD // App Password Gmail
  }
});

/* ── Multer (pièces jointes) ── */
const upload = multer({ storage: multer.memoryStorage() });

/* ─────────────────────────────────────────────
   CLIENTS
───────────────────────────────────────────── */

/* GET  /api/clients  — liste tous les clients */
app.get('/api/clients', async (req, res) => {
  try {
    const clients = await clientsCol.find({}).toArray();
    res.json(clients);
  } catch (err) {
    console.error('Erreur GET /api/clients :', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

/* GET  /api/clients/:id  — un client par ID */
app.get('/api/clients/:id', async (req, res) => {
  try {
    const client = await clientsCol.findOne({ _id: new ObjectId(req.params.id) });
    if (!client) return res.status(404).json({ error: 'Client introuvable' });
    res.json(client);
  } catch (err) {
    console.error('Erreur GET /api/clients/:id :', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

/* POST /api/clients/new  — créer un client */
app.post('/api/clients/new', async (req, res) => {
  const { name, emails } = req.body;

  if (!name || typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'Le nom du client est requis.' });
  }
  if (!Array.isArray(emails) || emails.length === 0) {
    return res.status(400).json({ error: 'Au moins un email est requis.' });
  }

  try {
    const result = await clientsCol.insertOne({ name: name.trim(), emails });
    res.status(201).json({ _id: result.insertedId, name: name.trim(), emails });
  } catch (err) {
    console.error('Erreur POST /api/clients/new :', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

/* ─────────────────────────────────────────────
   REMORQUES (trucks)

   Structure stockée en base :
   {
     refTruck:  string,
     matricule: string,
     clientIds: ObjectId[]   ← relation par référence (normalisée)
   }

   Les données complètes des clients sont résolues via populate
   à la lecture (GET /api/trucks).
───────────────────────────────────────────── */

/* GET  /api/trucks  — liste avec clients populés */
app.get('/api/trucks', async (req, res) => {
  try {
    const trucks = await trucksCol.find({}).toArray();

    /* Populate : résoudre les clientIds en objets complets */
    const populated = await Promise.all(
      trucks.map(async (truck) => {
        let selectedClients = [];

        if (Array.isArray(truck.clientIds) && truck.clientIds.length > 0) {
          const objectIds = truck.clientIds
            .map(id => {
              try { return new ObjectId(id) } catch { return null }
            })
            .filter(Boolean);

          selectedClients = await clientsCol
            .find({ _id: { $in: objectIds } })
            .toArray();
        } else if (Array.isArray(truck.selectedClients)) {
          // Compatibilité avec l'ancien schéma (clients embarqués)
          selectedClients = truck.selectedClients;
        }

        return { ...truck, selectedClients };
      })
    );

    res.json(populated);
  } catch (err) {
    console.error('Erreur GET /api/trucks :', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

/* POST /api/trucks/new  — créer un remorque */
app.post('/api/trucks/new', async (req, res) => {
  const { refTruck, matricule, clientIds, selectedClients } = req.body;

  if (!refTruck || !matricule) {
    return res.status(400).json({ error: 'La référence et le matricule sont requis.' });
  }

  /*
    Priorité : clientIds (relation normalisée).
    Fallback : selectedClients embarqués (rétrocompatibilité).
  */
  const docToInsert = {
    refTruck:  refTruck.trim(),
    matricule: matricule.trim(),
    clientIds: Array.isArray(clientIds) ? clientIds : [],
    // On conserve selectedClients uniquement si clientIds est absent
    ...((!clientIds || clientIds.length === 0) && { selectedClients: selectedClients ?? [] })
  };
  
  try {
    const result = await trucksCol.insertOne(docToInsert);
    res.status(201).json({ _id: result.insertedId, ...docToInsert });
  } catch (err) {
    console.error('Erreur POST /api/trucks/new :', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

/* ─────────────────────────────────────────────
   ENVOI D'EMAILS
   POST /api/send-email

   Corps attendu :
   {
     trucks:  Truck[],   // remorques avec selectedClients populés
     objet:   string,
     message: string
     }
     Fichiers via multipart/form-data (champ "attachments")
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

  // ── SSE headers ──
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders()

  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`)

  try {
    for (const truck of trucks) {
      send({ type: 'truck_start', truck: { matricule: truck.matricule, refTruck: truck.refTruck } })

for (const client of truck.selectedClients) {
  if (!Array.isArray(client.emails) || client.emails.length === 0) {
    send({ type: 'client_skip', client: client.name, matricule: truck.matricule, reason: 'Aucun email' })
    continue
  }

  send({ type: 'client_sending', client: client.name, matricule: truck.matricule })

  const mailOptions = {
    from:    process.env.MAIL_ADRESSE,
    to:      client.emails.join(', '),
    cc:      process.env.MAIL_ADRESSE_CC,
    subject: `${objet} — ${client.name} | ${truck.matricule} / ${truck.refTruck}`.toUpperCase(),
    text:    message,
    attachments
  }
  await transporter.sendMail(mailOptions)
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
// app.post('/api/send-email', upload.array('attachments'), async (req, res) => {
//   /* Support JSON classique ET multipart */
//   const body    = req.body;
//   const trucks  = typeof body.trucks === 'string' ? JSON.parse(body.trucks) : body.trucks;
//   const objet   = body.objet;
//   const message = body.message;

//   if (!trucks || !objet || !message) {
//     return res.status(400).json({ error: 'trucks, objet et message sont requis.' });
//   }

//   /* Pièces jointes (si multipart) */
//   const attachments = (req.files || []).map(f => ({
//     filename:    f.originalname,
//     content:     f.buffer,
//     contentType: f.mimetype
//   }));

//   console.log('/// Début envoi emails');

//   try {
//     for (const truck of trucks) {
//       console.log(`/// Remorque : ${truck.matricule} / ${truck.refTruck}`);

//       for (const client of truck.selectedClients) {
//         if (!Array.isArray(client.emails) || client.emails.length === 0) {
//           console.warn(`  Aucun email pour le client "${client.name}", ignoré.`);
//           continue;
//         }

//         const mailOptions = {
//           from:        'testrimad@gmail.com',
//           to:          client.emails.join(', '),
//           cc:          'testrimad@gmail.com',
//           subject:     `${objet} — ${client.name} | ${truck.matricule} / ${truck.refTruck}`,
//           text:        message,
//           attachments
//         };

//         await transporter.sendMail(mailOptions);
//         console.log(`  ✓ Email envoyé à "${client.name}" (${client.emails.join(', ')})`);
//       }
//     }

//     console.log('/// Fin envoi emails');
//     res.json({ message: 'Emails envoyés avec succès.' });

//   } catch (err) {
//     console.error('Erreur lors de l\'envoi des emails :', err);
//     res.status(500).json({ error: 'Erreur lors de l\'envoi des emails.' });
//   }
// });

/* ── Démarrage ── */
app.listen(PORT, () => {
  console.log(`Serveur démarré sur http://localhost:${PORT}`);
});


// const express = require('express');
// const app = express();
// const PORT = 3600;
// const cors = require('cors')
// app.use(cors());
// app.use(express.json());

// const { MongoClient } = require('mongodb');
// const uri = 'mongodb://localhost:27017/avis_de_retard'; // Replace with your MongoDB connection string
// const client = new MongoClient(uri);

// async function connectToMongoDB() {
//   try {
//     await client.connect();
//     console.log('Connected to MongoDB');
//   } catch (error) {
//     console.error('Error connecting to MongoDB:', error);
//   }
// }

// connectToMongoDB();

// const db = client.db('avis_de_retard'); // Replace with your database name
// const clientsCollection = db.collection('clients');
// const trucksCollection = db.collection('trucks');

// const nodemailer = require('nodemailer');
// const transporter = nodemailer.createTransport({
//  service: 'gmail',
//  auth: {
//    user: 'testrimad@gmail.com',
//    pass: 'aijq gldq flzo ykqr' // Use App Password if using Gmail
//  }
// });
// const groups = [
//   { 
//     name: 'Group 1', emails: ['imadtawab03@gmail.com', 'imadtawab@gmail.com'] },
//   { 
//     name: 'Group 2', emails: ['imadtrader03@gmail.com', 'fetchlystore9@gmail.com']
//   }
// ]
// app.get('/ll', (req, res) => {

//   groups.forEach(group => {
//     const mailOptions = {
//  from: 'testrimad@gmail.com',
//  to: group.emails.join(', '),
//  cc: "testrimad@gmail.com",
//  subject: 'AVIS DE RETARD -- ' + group.name,
//  text: 'This is a test email sent from Node.js!'
// };
//  transporter.sendMail(mailOptions, (error, info) => {
//   if (error) {
//     console.log(error);
//     res.status(500).send('Error sending email');
//   } else {
//     console.log('Email sent: ' + info.response);
//     res.send('<h1>Hello World!jjj</h1><p>Your Express server is running and email sent for multiple recipients.</p>');
//   }
// });
//   });
// });
// app.get('/api/clients', async (req, res) => {
//   try {
//     const clients = await clientsCollection.find({}).toArray();
//     res.json(clients);
//   } catch (error) {
//     console.error('Error fetching clients:', error);
//     res.status(500).json({ error: 'Internal server error' });
//   }
// });
// app.post('/api/clients/new', async (req, res) => {
//   const { name, emails } = req.body;
//   try {
//     const result = await clientsCollection.insertOne({ name, emails });
//     res.json({ _id: result.insertedId, name, emails });
//   } catch (error) {
//     console.error('Error adding client:', error);
//     res.status(500).json({ error: 'Internal server error' });
//   }
// });
// app.post('/api/trucks/new', async (req, res) => {
//   const { refTruck, matricule, selectedClients } = req.body;
//   try {
//     const result = await trucksCollection.insertOne({ refTruck, matricule, selectedClients });
//     res.json({ _id: result.insertedId, refTruck, matricule, selectedClients });
//   } catch (error) {
//     console.error('Error adding truck:', error);
//     res.status(500).json({ error: 'Internal server error' });
//   }
// });

// app.get('/api/trucks', async (req, res) => {
//   try {
//     const trucks = await trucksCollection.find({}).toArray();
//     res.json(trucks);
//   } catch (error) {
//     console.error('Error fetching trucks:', error);
//     res.status(500).json({ error: 'Internal server error' });
//   }
// });
// // app.post('/api/send-email', async (req, res) => {
// //   const { trucks, objet, message, files } = req.body;
// //   // const allClients = [...new Set(trucks.flatMap(t => t.selectedClients))];
// //   // console.log(trucks, "&&&&", allClients)
// //   // const allEmails = allClients.flatMap(c => c.emails);
// //   // console.log(allEmails)
// //   console.log(" /// Start send emails")
// //   trucks.forEach(async t => {
    
// //     console.log(" /// Start for truck : ", t.matricule ," / ", t.refTruck)
// //     t.selectedClients.forEach(async c => {
// //   console.log(" /// Start for client : ", c.name)

// //       const mailOptions = {
// //         from: 'testrimad@gmail.com',
// //         to: c.emails.join(', '),
// //         cc: "testrimad@gmail.com",
// //         subject: objet + ' -- ' + c.name + ' | ' + t.matricule + " / " + t.refTruck,
// //         text: message
// //       };

// //       // console.log(mailOptions)
      
// //       try {
// //     await transporter.sendMail(mailOptions);
// //     // res.send('Email sent successfully');
// //             console.log(" /// End for client : ", c.name, " truck : ", t.matricule, " / ", t.refTruck);
// //   } catch (error) {
// //     console.error('Error sending email:', error);
// //     res.status(500).send('Error sending email');
// //   }

// // })
// // console.log(" /// End for truck : ", t.matricule ," / ", t.refTruck)

// //     })
// //   console.log(" /// End send emails")

    
// // res.send('Emails sent successfully')


// // });
// app.post('/api/send-email', async (req, res) => {
//   const { trucks, objet, message, files } = req.body;

//   console.log("/// Start send emails");

//   try {
//     for (const t of trucks) {
//       console.log("/// Start for truck:", t.matricule, "/", t.refTruck);

//       for (const c of t.selectedClients) {
//         console.log("/// Start for client:", c.name);

//         const mailOptions = {
//           from: 'testrimad@gmail.com',
//           to: c.emails.join(', '),
//           cc: "testrimad@gmail.com",
//           subject: `${objet} -- ${c.name} | ${t.matricule} / ${t.refTruck}`,
//           text: message
//         };

//         await transporter.sendMail(mailOptions);
//         console.log("/// Email sent to:", c.name, "| truck:", t.matricule, "/", t.refTruck);
//       }

//       console.log("/// End for truck:", t.matricule, "/", t.refTruck);
//     }

//     console.log("/// End send emails");
//     res.send('Emails sent successfully');

//   } catch (error) {
//     console.error('Error sending email:', error);
//     res.status(500).send('Error sending email');
//   }
// });


// app.listen(PORT, () => {
//  console.log(`Server is listening at http://localhost:${PORT}`);
// });