import express, { json, urlencoded } from "express";
import { AuthManager, DatabaseConnection, UserFacingError } from "./db.js";
import cookieParser from "cookie-parser";

const app = express();
const port = 3000;
app.listen(port);
console.log("Server started at http://localhost:" + port);

app.use(json());
app.use(urlencoded({ extended: true }));
app.use(cookieParser());
// user info middleware
app.use((req, res, next) =>
  (async () => {
    if (req.cookies["ItsMe"]) {
      const auth = new AuthManager();
      req.user = await auth.getUser(req.cookies["ItsMe"]);
    }
    next();
  })().catch(next)
);

app.set("views", "./views");
app.set("view engine", "ejs");

const DAY_MS = 1000 * 60 * 60 * 24

app.get("/", async (req, res) => {
  if (!req.user) {
    res.render("login");
  }
  else {
    const db = new DatabaseConnection();
    const topics = await db.getTopics();
    res.render("home", { topics, user: req.user })
  }
});

app.post("/login", async (req, res) => {
  const { username, password } = req.body;
  if (username && password) {
    try {
      const auth = new AuthManager();
      const token = await auth.login(username, password);
      res.cookie("ItsMe", token, { maxAge: DAY_MS });
      res.type("html");
      res.end("Good job you logged in")
    }
    catch (error) {
      showErrorPage(res, error)
    }
  } else {
    showErrorPage(res, "Invalid username or password.")
  }
});

/**
 * @param {Error | string} error 
 * @param {import("express").Response<any, Record<string, any>, number>} res 
 */
function showErrorPage(res, error) {
  if (error instanceof UserFacingError) {
    res.render("error", { errorMessage: error.message, userFacing: true });
  }
  else if (typeof error === "string") {
    res.render("error", { errorMessage: error, userFacing: true });
  }
  else {
    res.render("error", { errorMessage: error.stack, userFacing: false });
  }
}