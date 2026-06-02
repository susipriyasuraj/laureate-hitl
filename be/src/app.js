import express from "express";
import dotenv from "dotenv";
import userRoutes from "./routes/userRoutes.js";
import jobRoutes from "./routes/jobRoutes.js";
import uiCompatRoutes from "./routes/uiCompatRoutes.js";
import cors from "cors"
import { syncStatus } from "./jobs/statusSync.js";

dotenv.config();

const app = express();

// Enable CORS for all origins (must be before other middleware)
app.use(cors());
app.use(express.json());

setInterval(async () => {
    try {
        await syncStatus()
    } catch (err) {
        console.error("Status sync failed:", err.message)
    }
}, 30000)

app.use("/api/users", userRoutes);
app.use("/jobs", jobRoutes);
app.use("/", uiCompatRoutes);

export default app;
