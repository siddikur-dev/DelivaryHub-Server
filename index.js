const express = require("express");
const app = express();
const cors = require("cors");
require("dotenv").config();
const port = process.env.PORT || 3000;
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

app.use(cors());
app.use(express.json());

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

    function generateTrackingId() {
      return "TRK" + Math.floor(Math.random() * 1000000);
    }

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
      try {
        const sessionId = req.query.session_id;
        if (!sessionId) {
          return res
            .status(400)
            .send({ success: false, message: "No session_id provided" });
        }

        const session = await stripe.checkout.sessions.retrieve(sessionId);

        if (session.payment_status !== "paid") {
          return res.send({ success: false, message: "Payment not completed" });
        }

        const parcelId = session.metadata.parcelId;
        console.log("Parcel ID", parcelId);
        const query = { _id: new ObjectId(parcelId) };
        const trackingId = generateTrackingId();

        const updateResult = await parcelsCollection.updateOne(query, {
          $set: { paymentStatus: "paid", trackingId },
        });

        if (updateResult.modifiedCount === 0) {
          return res.send({
            success: false,
            message: "Parcel not found or already updated",
          });
        }

        const payment = {
          amount: session.amount_total / 100,
          currency: session.currency,
          customerEmail: session.customer_email,
          parcelId,
          parcelName: session.metadata.parcelName,
          transactionId: session.payment_intent,
          paymentStatus: session.payment_status,
          paidAt: new Date(),
        };

        const paymentResult = await paymentCollection.insertOne(payment);

        res.send({
          success: true,
          trackingId,
          transactionId: session.payment_intent,
          paymentInfo: paymentResult,
        });
      } catch (error) {
        console.error(error);
        res.status(500).send({ success: false, message: "Server error" });
      }
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
