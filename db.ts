import { Db, Filter, MongoClient, ObjectId, Timestamp, WithId } from "mongodb";
import { Topic, TopicWithUsers, User } from "./types.js";
import { WebSocket } from "ws";
const { createHash, randomBytes } = await import("node:crypto");

// The uri string must be the connection string for the database (obtained on Atlas).
const uri = `mongodb+srv://jtalbot:${encodeURIComponent(
    process.env.MONGO_DB_PASSWORD as string
)}@mycluster.dwhh37z.mongodb.net/?retryWrites=true&w=majority&appName=MyCluster`;

export const intl = new Intl.DateTimeFormat("en-us", {
    timeZone: "America/Chicago",
    dateStyle: "full",
    timeStyle: "full",
});

export class TopicSubscriptionService {
    static #instance: TopicSubscriptionService;
    subscriptions: Map<string, TopicSubscription>;

    constructor() {
        if (TopicSubscriptionService.#instance) {
            return TopicSubscriptionService.#instance;
        }
        this.subscriptions = new Map();
        TopicSubscriptionService.#instance = this;
    }

    registerToTopic(topicId: string, subscriber: WebSocket) {
        let sub = this.subscriptions.get(topicId);
        if (!sub) {
            sub = new TopicSubscription();
            this.subscriptions.set(topicId, sub);
        }
        sub.register(subscriber);
    }

    notifyTopic(topic: WithId<Topic>) {
        const sub = this.subscriptions.get(topic._id.toString("hex"));
        if (sub) {
            sub.notify(topic);
        }
    }

    async notifyTopicById(topicId: ObjectId) {
        const db = new DatabaseConnection();
        const topic = await db.getTopic(topicId, false);
        this.notifyTopic(topic);
    }
}

export class TopicSubscription {
    subscribers: Set<WebSocket>

    constructor() {
        this.subscribers = new Set();
    }

    register(subscriber: WebSocket) {
        this.subscribers.add(subscriber);

        subscriber.on("close", () => {
            this.subscribers.delete(subscriber);
        })
    }

    notify(topic: WithId<Topic>) {
        const subs = [...this.subscribers.values()]
        subs.forEach(sub => {
            if (sub.readyState === sub.OPEN) {
                sub.send(JSON.stringify(topic), { binary: false, compress: true });
            }
        });
    }
}

export class DatabaseConnection {
    static #instance: DatabaseConnection;
    db: Db;

    constructor() {
        if (DatabaseConnection.#instance) {
            return DatabaseConnection.#instance;
        }
        this.#connect();
        DatabaseConnection.#instance = this;
    }

    #connect() {
        const client = new MongoClient(uri);
        client.connect();
        this.db = client.db("tweeter");
    }

    getUser(id: ObjectId) {
        const users = this.db.collection<User>("users");
        return users.findOne({ _id: id });
    }

    findUser(filter: Filter<User>) {
        const users = this.db.collection<User>("users");
        return users.findOne(filter);
    }

    createUser(user: User) {
        const users = this.db.collection<User>("users");
        return users.insertOne(user);
    }

    getTopics() {
        const topics = this.db.collection<Topic>("topics");
        return topics.find().sort({ lastBump: -1 }).toArray();
    }

    getSubscribedTopics(userId: ObjectId) {
        const topics = this.db.collection<Topic>("topics");
        return topics
            .aggregate([
              {
                $sort: {
                  lastBump: -1
                }
              },
                {
                    $match: {
                        subscribers: userId,
                    },
                },
                {
                    $set: {
                        users: {
                            $map: {
                                input: "$posts",
                                in: "$$this.author",
                            },
                        },
                    },
                },
                {
                    $lookup: {
                        from: "users",
                        localField: "users",
                        foreignField: "_id",
                        as: "users",
                        pipeline: [
                            {
                                $unset: "passwordHash",
                            },
                        ],
                    },
                },
            ])
            .toArray();
    }

    /**
     * @param id ID of the topic.
     * @param isAccess Should increment accessCount of the topic.
     */
    async getTopic(id: ObjectId, isAccess: boolean = true) {
        const topics = this.db.collection<Topic>("topics");
        const topic = await topics
            .aggregate<WithId<TopicWithUsers>>([
                {
                    $match: {
                        _id: id,
                    },
                },
                {
                    $set: {
                        users: {
                            $map: {
                                input: "$posts",
                                in: "$$this.author",
                            },
                        },
                    },
                },
                {
                    $lookup: {
                        from: "users",
                        localField: "users",
                        foreignField: "_id",
                        as: "users",
                        pipeline: [
                            {
                                $unset: "passwordHash",
                            },
                        ],
                    },
                },
            ])
            .next();

        if (topic && isAccess) {
            topics.updateOne({ _id: id }, { $inc: { accessCount: 1 } });
        }
        return topic;
    }

    async createTopic(title: string, authorId: ObjectId, body: string) {
        const topics = this.db.collection<Topic>("topics");
        return topics.insertOne({
            title,
            lastBump: new Date(),
            accessCount: 0,
            posts: [
                {
                    author: authorId,
                    created: new Date(),
                    body,
                },
            ],
            subscribers: [authorId],
        });
    }

    /**
     * @param topicId The post ID.
     * @param authorId The author's user ID.
     * @param body The body of the post.
     */
    async createPost(topicId: ObjectId, authorId: ObjectId, body: string) {
        const topics = this.db.collection<Topic>("topics");
        await topics.updateOne(
            { _id: topicId },
            {
                $set: {
                    lastBump: new Date(),
                },
                $push: {
                    posts: {
                        author: authorId,
                        created: new Date(),
                        body,
                    },
                },
            });
        
        const subService = new TopicSubscriptionService();
        subService.notifyTopicById(topicId);
    }

    async subscribeToTopic(topicId: ObjectId, userId: ObjectId) {
        const topics = this.db.collection<Topic>("topics");
        return topics.updateOne(
            { _id: topicId },
            {
                $push: {
                    subscribers: userId,
                },
            }
        );
    }

    async unsubscribeFromTopic(topicId: ObjectId, userId: ObjectId) {
        const topics = this.db.collection<Topic>("topics");
        return topics.updateOne(
            { _id: topicId },
            {
                $pull: {
                    subscribers: userId,
                },
            }
        );
    }
}

export class UserFacingError extends Error {}

/** unnecessary convoluted nonsense for the sake of not saving passwords in plaintext */
export class AuthManager {
    /** @type {AuthManager} */
    static #instance;

    /** @type {Map<string, ObjectId>} */
    #tokenMap = new Map();

    constructor() {
        if (AuthManager.#instance) {
            return AuthManager.#instance;
        }
        AuthManager.#instance = this;
    }

    /**
     * @param username Username
     * @param password Password
     * Auth token
     */
    async login(username: string, password: string) {
        const passwordHash = AuthManager.#pwhash(password);

        const db = new DatabaseConnection();
        const user = await db.findUser({ username, passwordHash });

        if (user) {
            /** @type {string | undefined} */
            let existingToken;
            for (const entry of this.#tokenMap.entries()) {
                if (user._id.equals(entry[1])) {
                    existingToken = entry[0];
                    break;
                }
            }

            if (existingToken) {
                return existingToken;
            }

            const token = await AuthManager.#generateToken();
            this.#tokenMap.set(token, user._id);
            return token;
        }
        throw new UserFacingError("Incorrect username or password");
    }

    async register(username: string, password: string) {
        const db = new DatabaseConnection();
        const existingUser = await db.findUser({ username });

        if (existingUser) {
            throw new UserFacingError("User already exists with this username");
        }

        await db.createUser({
            username,
            passwordHash: AuthManager.#pwhash(password),
        });
        return await this.login(username, password);
    }

    getUser(authToken: string) {
        const id = this.#tokenMap.get(authToken);
        if (id) {
            const db = new DatabaseConnection();
            return db.getUser(id);
        }
    }

    logout(authToken: string) {
        return this.#tokenMap.delete(authToken);
    }

    /**
     * Makes a hash string from a password
     * @param password
     * @returns hash string
     */
    static #pwhash(password: string) {
        const passwordHasher = createHash("sha512");
        passwordHasher.update(password, "utf8");
        return passwordHasher
            .digest()
            .reduce((prev, cur) => prev + cur.toString(16), "");
    }

    /**
     * just generates a completely random 64 byte string
     * @returns the "token" in question
     */
    static #generateToken() {
        return new Promise<string>((resolve, reject) => {
            randomBytes(64, (err, buf) => {
                if (err) reject(err);
                const token = buf.toString("base64");
                resolve(token);
            });
        });
    }
}
