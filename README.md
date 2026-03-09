# GEU Admission Dashboard

Node.js + Express + MongoDB dashboard for Graphic Era University student data.

## Features
- Upload CSV once → stored in MongoDB permanently
- Filter by Date Range, Campus, Course Name
- Click student name → popup with all details (Enquiry / Registration / Admission dates)
- Download filtered reports as Excel
- Deploy on Render

## Local Setup

```bash
cd admission-dashboard
npm install
```

Create a `.env` file:
```
MONGO_URI=mongodb://localhost:27017/admission_dashboard
PORT=3000
```

Run:
```bash
npm start
```

Open `http://localhost:3000`

## Deploy on Render

### Step 1: Create free MongoDB Atlas cluster
1. Go to https://www.mongodb.com/atlas → Create free account
2. Create a free M0 cluster
3. Create a Database User (username + password)
4. Under Network Access → Add `0.0.0.0/0` (allow all IPs)
5. Get the connection string: `mongodb+srv://username:password@cluster0.xxxxx.mongodb.net/admission_dashboard`

### Step 2: Push to GitHub
```bash
cd admission-dashboard
git init
git add .
git commit -m "Initial commit"
git remote add origin https://github.com/YOUR_USERNAME/admission-dashboard.git
git push -u origin main
```

### Step 3: Deploy on Render
1. Go to https://render.com → New → **Web Service**
2. Connect your GitHub repo
3. Settings:
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Environment Variables:** Add `MONGO_URI` = your Atlas connection string
4. Click **Deploy**

Your dashboard will be live at `https://your-app.onrender.com`
