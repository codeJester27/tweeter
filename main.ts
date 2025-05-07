import express, { json, Response, urlencoded } from "express";
import expressWs from "express-ws";
import {
    AuthManager,
    DatabaseConnection,
    intl,
    TopicSubscriptionService,
    UserFacingError,
} from "./db.js";
import cookieParser from "cookie-parser";
import { ObjectId } from "mongodb";
import { WebSocket } from "ws";

const app = expressWs(express()).app;

const port = process.env.PORT || 3000;
app.listen(port);
console.log("Server started at http://localhost:" + port);

app.use(json());
app.use(urlencoded({ extended: true }));
app.use(cookieParser());
app.use(express.static("static"));

// user info middleware
app.use((req, res, next) =>
    (async () => {
        if (req.cookies["ItsMe"]) {
            const auth = new AuthManager();
            req.user = (await auth.getUser(req.cookies["ItsMe"])) ?? undefined;
        }
        next();
    })().catch(next)
);

app.set("views", "./views");
app.set("view engine", "ejs");

const DAY_MS = 1000 * 60 * 60 * 24;



app.get("/", async (req, res) => {
    const user = req.user;
    if (!user) {
        res.render("login");
        return;
    }
    const db = new DatabaseConnection();
    const topics = await db.getSubscribedTopics(user._id);
    res.render("home", { topics, user, intl, showPosts: true });
});

app.get("/all", async (req, res) => {
    const user = req.user;
    if (!user) {
        res.render("login");
        return;
    }
    const db = new DatabaseConnection();
    const topics = await db.getTopics();
    res.render("home", { topics, user, intl });
});

app.get("/createTopic", (req, res) => {
    const user = req.user;
    if (!user) {
        res.status(401);
        res.end();
        return;
    }

    res.render("create", { user });
});

app.post("/createTopic", async (req, res) => {
    const user = req.user;
    if (!user) {
        showErrorPage(res, "Please log in to create topic");
        return;
    }

    if (
        !(
            req.body &&
            typeof req.body.title === "string" &&
            typeof req.body.body === "string"
        )
    ) {
        showErrorPage(res, "Cannot make an empty topic");
        return;
    }

    const { title, body } = req.body;

    try {
        const db = new DatabaseConnection();
        const insertRes = await db.createTopic(title, user._id, body);
        res.redirect("/topic/" + insertRes.insertedId);
    } catch (error) {
        showErrorPage(res, error);
    }
});

app.post("/logout", (req, res) => {
    if (!req.user || !req.cookies["ItsMe"]) {
        res.end();
        return;
    }
    const auth = new AuthManager();
    auth.logout(req.cookies["ItsMe"]);
    res.clearCookie("ItsMe");
    res.end();
});

const objectIdRegex = /^[0-9a-f]{24}$/i;

app.ws("/topic", (ws) => {
    ws.once("message", (data, isBinary) => {
        const text = data.toString('utf8')
        if (isBinary) {
            ws.close();
            return;
        }

        if (objectIdRegex.test(text)) {
            const subService = new TopicSubscriptionService();
            subService.registerToTopic(text, ws);
            return;
        }
        
        try {
            const array = JSON.parse(text);
            if (array instanceof Array && array.every(x => typeof x === "string" && objectIdRegex.test(x))) {
                const subService = new TopicSubscriptionService();
                array.forEach(topicId => {
                    subService.registerToTopic(topicId, ws);
                });
                return;
            }
        } catch (_) {}
        ws.close();
    })
})

/*app.delete("/topic/:topicId", async (req,res) => {
  if (!req.user) {
    res.redirect("/");
  return;
}
})*/

app.get("/topic/:topicId", async (req, res) => {
    const user = req.user;
    if (!user) {
        res.redirect("/");
        return;
    }

    const { topicId } = req.params;

    if (!topicId) {
        showErrorPage(res, "Cannot post without a topic id");
        return;
    }

    try {
        const db = new DatabaseConnection();
        const topic = await db.getTopic(new ObjectId(topicId), true);
        if (topic) {
            res.render("topic", { user, topic, intl });
        } else {
            showErrorPage(res, "Topic not found");
            return;
        }
    } catch (error) {
        showErrorPage(res, error);
    }
});

app.post("/login", async (req, res) => {
    const { username, password } = req.body;
    if (username && password) {
        try {
            const auth = new AuthManager();
            const token = await auth.login(username, password);
            res.cookie("ItsMe", token, { maxAge: DAY_MS });
            res.redirect("/");
        } catch (error) {
            showErrorPage(res, error);
        }
    } else {
        showErrorPage(res, "Invalid username or password.");
    }
});

app.post("/register", async (req, res) => {
    const { username, password } = req.body;
    if (username && password) {
        try {
            const auth = new AuthManager();
            const token = await auth.register(username, password);
            res.cookie("ItsMe", token, { maxAge: DAY_MS });
            res.type("html");
            res.redirect("/");
        } catch (error) {
            showErrorPage(res, error);
        }
    } else {
        showErrorPage(res, "Invalid username or password.");
    }
});

app.post("/unsubscribe/:topicId", async (req, res) => {
    const user = req.user;
    if (!user) {
        showErrorPage(res, "Login before subscribing");
        return;
    }
    const { topicId } = req.params;

    try {
        const db = new DatabaseConnection();
        await db.unsubscribeFromTopic(new ObjectId(topicId), user._id);
        res.end();
    } catch (error) {
        showErrorPage(res, error);
    }
});

app.post("/subscribe/:topicId", async (req, res) => {
    const user = req.user;
    if (!user) {
        showErrorPage(res, "Login before subscribing");
        return;
    }

    const { topicId } = req.params;

    try {
        const db = new DatabaseConnection();
        await db.subscribeToTopic(new ObjectId(topicId), user._id);
        res.end();
    } catch (error) {
        showErrorPage(res, error);
    }
});

app.post("/topic/:topicId/post", async (req, res) => {
    const user = req.user;
    if (!user) {
        showErrorPage(res, "Please log in to post");
        return;
    }
    const { topicId } = req.params;

    if (!req.body || !req.body.body) {
        showErrorPage(res, "Cannot make an empty post");
        return;
    }

    const { body } = req.body;

    if (!topicId) {
        showErrorPage(res, "Cannot post without a topic id");
        return;
    }

    try {
        const db = new DatabaseConnection();
        await db.createPost(new ObjectId(topicId), user._id, body);
    } catch (error) {
        showErrorPage(res, error);
    }
    res.redirect(`/topic/${topicId}`);
});

function showErrorPage(res: Response, error: Error | string) {
    if (error instanceof UserFacingError) {
        res.render("error", { errorMessage: error.message, userFacing: true });
    } else if (typeof error === "string") {
        res.render("error", { errorMessage: error, userFacing: true });
    } else if (error) {
        res.render("error", {
            errorMessage: error.stack ?? error.message,
            userFacing: false,
        });
    } else {
        res.render("error", { errorMessage: error, userFacing: false });
    }
}
