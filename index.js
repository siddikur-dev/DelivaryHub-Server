const express = require("express");
const app = express();
const cors = require("cors");
require("dotenv").config();
const port = process.env.PORT || 3000;
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

app.use(cors());
app.use(express.json());
const crypto = require("crypto");

const admin = require("firebase-admin");

const serviceAccount = require("./delivaryhub-firebase-adminsdk.json");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

function generateTrackingId() {
  const prefix = "TRK";

  // format: YYYYMMDD
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");

  // random hex (8 chars)
  const randomHex = crypto.randomBytes(4).toString("hex").toUpperCase();

  return `${prefix}-${date}-${randomHex}`;
}

// Firebase verification
const verifyFBToken = async (req, res, next) => {
  const token = req.headers.authorization;

  if (!token) {
    return res.status(401).send({ message: "unauthorized access" });
  }

  try {
    const idToken = token.split(" ")[1];
    const decoded = await admin.auth().verifyIdToken(idToken);
    console.log("decoded in the token", decoded);
    req.decoded_email = decoded.email;
    next();
  } catch (err) {
    return res.status(401).send({ message: "unauthorized access" });
  }
};



const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.rfkbq1n.mongodb.net/?appName=Cluster0`;
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    await client.connect();
    const deliveryDB = client.db("deliveryDB");
    const parcelsCollection = deliveryDB.collection("parcel");
    const paymentCollection = deliveryDB.collection("payments");
    const userCollection = deliveryDB.collection("users");
    const riderCollection = deliveryDB.collection("riders");

    // verify  Admin Middleware
    const verifyAdmin = async (req, res, next) => {
      const email = req.decoded_email;
      const query = { email }
      const user = await userCollection.findOne(query)
      if (!user || user.role !== 'admin') {
        return res.status(403).send({ message: "forbidden access" });
      }
      next()
    }
    // user related api
    app.post("/users", async (req, res) => {
      const user = req.body;
      user.role = "user";
      const email = user.email;
      const existUser = await userCollection.findOne({ email });
      if (existUser) {
        return res.send({ message: "This user exists" });
      }
      user.createdAt = new Date();
      const result = await userCollection.insertOne(user);
      res.send(result);
    });

    app.get("/users", async (req, res) => {
      const searchText = req.query.searchText || "";

      let query = {};

      if (searchText) {
        query = {
          $or: [
            { displayName: { $regex: searchText, $options: "i" } },
            { email: { $regex: searchText, $options: "i" } }
          ]
        };
      }

      const users = await userCollection
        .find(query)
        .sort({ createdAt: 1 })
        .limit(5)
        .toArray();

      res.send(users);
    });


    app.get('/users/:email/role', async (req, res) => {
      const email = req.params.email;
      const query = { email };
      const user = await userCollection.findOne(query);
      res.send({ role: user?.role || 'user' });
    })

    app.patch("/users/:id/role", verifyFBToken, verifyAdmin, async (req, res) => {
      const id = req.params.id
      const roleInfo = req.body;
      const query = { _id: new ObjectId(id) };
      const updatedDoc = {
        $set: {
          role: roleInfo.role,
        },
      };
      const cursor = userCollection.updateOne(query, updatedDoc);
      const users = await cursor;
      res.send(users);
    });

    // parcel related api
    app.post("/parcels", async (req, res) => {
      const parcel = req.body;
      parcel.createdAt = new Date();
      const result = await parcelsCollection.insertOne(parcel);
      res.send(result);
    });

    app.get("/parcels", async (req, res) => {
      const query = {};
      const { email } = req.query;
      if (email) query.senderEmail = email;
      const options = { sort: { createdAt: -1 } };
      const result = await parcelsCollection.find(query, options).toArray();
      res.send(result);
    });

    app.get("/parcels/:id", async (req, res) => {
      const id = req.params.id;
      const result = await parcelsCollection.findOne({ _id: new ObjectId(id) });
      res.send(result);
    });

    app.delete("/parcels/:id", async (req, res) => {
      const id = req.params.id;
      const result = await parcelsCollection.deleteOne({
        _id: new ObjectId(id),
      });
      res.send(result);
    });

    // payment related api
    app.post("/checkout-session", async (req, res) => {
      try {
        const { cost, parcelId, parcelName, senderEmail } = req.body;
        const amount = Number(cost) * 100;

        const session = await stripe.checkout.sessions.create({
          payment_method_types: ["card"],
          line_items: [
            {
              price_data: {
                currency: "USD",
                unit_amount: amount,
                product_data: { name: parcelName },
              },
              quantity: 1,
            },
          ],
          mode: "payment",
          customer_email: senderEmail,
          metadata: { parcelId, parcelName },
          success_url: `${process.env.LIVE_SITE_DOMAIN}/dashboard/payment-success?session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: `${process.env.LIVE_SITE_DOMAIN}/dashboard/payment-cancelled`,
        });

        res.send({ url: session.url });
      } catch (error) {
        console.error(error);
        res.status(500).send({ error: error.message });
      }
    });

    app.patch("/payment-success", async (req, res) => {
      const sessionId = req.query.session_id;
      const session = await stripe.checkout.sessions.retrieve(sessionId);

      // console.log('session retrieve', session)
      const transactionId = session.payment_intent;
      const query = { transactionId: transactionId };

      const paymentExist = await paymentCollection.findOne(query);
      console.log(paymentExist);
      if (paymentExist) {
        return res.send({
          message: "already exists",
          transactionId,
          trackingId: paymentExist.trackingId,
        });
      }

      const trackingId = generateTrackingId();
      console.log(trackingId);

      if (session.payment_status === "paid") {
        const id = session.metadata.parcelId;
        const query = { _id: new ObjectId(id) };
        const update = {
          $set: {
            paymentStatus: "paid",
            trackingId: trackingId,
          },
        };

        const result = await parcelsCollection.updateOne(query, update);

        const payment = {
          amount: session.amount_total / 100,
          currency: session.currency,
          customerEmail: session.customer_email,
          parcelId: session.metadata.parcelId,
          parcelName: session.metadata.parcelName,
          transactionId: session.payment_intent,
          paymentStatus: session.payment_status,
          paidAt: new Date(),
          trackingId: trackingId,
        };

        if (session.payment_status === "paid") {
          const resultPayment = await paymentCollection.insertOne(payment);

          res.send({
            success: true,
            modifyParcel: result,
            trackingId: trackingId,
            transactionId: session.payment_intent,
            paymentInfo: resultPayment,
          });
        }
      }

      res.send({ success: false });
    });

    app.get("/payments", verifyFBToken, async (req, res) => {
      const email = req.query.email;
      const query = {};

      if (email) {
        query.customerEmail = email;

        // check if token email matches the query email
        if (email !== req.decoded_email) {
          return res.status(403).send({ message: "forbidden access" });
        }
      }

      const result = await paymentCollection
        .find(query)
        .sort({ paidAt: -1 })
        .toArray();

      res.send(result);
    });


    // rider related api
    app.post("/riders", async (req, res) => {
      try {
        const rider = req.body;
        rider.status = "pending";
        rider.createdAt = new Date();

        const email = rider.email; // rider data থেকে email নাও
        const existUser = await riderCollection.findOne({ email });

        if (existUser) {
          return res.status(400).send({ message: "This user already exists" });
        }

        const result = await riderCollection.insertOne(rider);
        res.send(result);
      } catch (error) {
        console.error("Error adding rider:", error);
        res.status(500).send({ message: "Internal Server Error" });
      }
    });

    app.get("/riders", async (req, res) => {
      const query = {};
      if (req.query.status) {
        query.status = req.query.status;
      }
      const cursor = riderCollection.find(query);
      const result = await cursor.toArray();
      res.send(result);
    });

    app.patch("/riders/:id", verifyFBToken, verifyAdmin, async (req, res) => {
      const { status } = req.body;
      const id = req.params.id;

      const query = { _id: new ObjectId(id) };
      const updatedDoc = {
        $set: { status },
      };

      if (status === "approved") {
        const email = req.body.email;
        const userQuery = { email };
        const updateUser = {
          $set: {
            role: "rider",
          },
        };
        const userResult = await userCollection.updateOne(
          userQuery,
          updateUser
        );
      }
      const result = await riderCollection.updateOne(query, updatedDoc);
      res.send(result);
    });

    app.delete("/riders/:id", async (req, res) => {
      const id = req.params.id;
      const result = await riderCollection.deleteOne({
        _id: new ObjectId(id),
      });
      res.send(result);
    });

    app.get("/", (req, res) => {
      res.send("Delivery Hub Server Running!");
    });

    await client.db("admin").command({ ping: 1 });
    console.log("Successfully connected to MongoDB!");
  } finally {
  }
}
run().catch(console.dir);

app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});
