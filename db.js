import { MongoClient, ObjectId, Timestamp } from "mongodb";
const { createHash, randomBytes } = await import("node:crypto");

// The uri string must be the connection string for the database (obtained on Atlas).
const uri = `mongodb+srv://jtalbot:${encodeURIComponent(
  process.env.MONGO_DB_PASSWORD
)}@mycluster.dwhh37z.mongodb.net/?retryWrites=true&w=majority&appName=MyCluster`;

export class DatabaseConnection {
  /** @type {DatabaseConnection} */
  static #instance;

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

  /**
   * @param {ObjectId} id 
   */
  getUser(id) {
    const users = this.db.collection("users")
    return users.findOne({ _id: id })
  }

  /**
   * @param {import("mongodb").Filter<{username: string, passwordHash: string}> | undefined} filter
   */
  findUser(filter) {
    const users = this.db.collection("users");
    return users.findOne(filter);
  }

  /**
   * 
   * @param {{username: string; passwordHash: string}} user 
   * @returns 
   */
  createUser(user) {
    const users = this.db.collection("users");
    return users.insertOne(user);
  }

  /**
   * 
   * @returns {Promise<{
   *  title: string;
   *  lastBump: Date;
   *  accessCount: number;
   *  posts: {
   *    author: ObjectId;
   *    created: Date;
   *    body: string;
   *  }[]
   * }[]>}
   */
  getTopics() {
    const topics = this.db.collection("topics");
    return topics.find().sort({ lastBump: -1 }).toArray()
  }

  /**
   * @param {ObjectId} id ID of the topic.
   * @param {boolean | undefined} isAccess Should increment accessCount of the topic.
   * @returns {Promise<{
   *  title: string;
  *  lastBump: Date;
  *  accessCount: number;
  *  posts: {
  *    author: ObjectId;
  *    created: Date;
  *    body: string;
  *  }[];
  *  subscribers: ObjectId[];
  * } | null>}
   */
  async getTopic(id, isAccess = true) {
    const topics = this.db.collection("topics");
    const topic = await topics.findOne({ _id: id });
    if (topic && isAccess) {
      topics.updateOne({ _id: id }, { $inc: { accessCount: 1 }});
    }
    return topic;
  }

  /**
   * @param {ObjectId} topicId The post ID.
   * @param {ObjectId} authorId The author's user ID.
   * @param {string} body The body of the post.
   */
  async createPost(topicId, authorId, body) {
    const topics = this.db.collection("topics");
    await topics.updateOne({ _id: topicId}, {$push: {posts: {
      author: authorId,
      created: new Date(),
      body
    }}});
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
   * @param {string} username Username
   * @param {string} password Password
   * @returns {Promise<string>}
   * Auth token
   */
  async login(username, password) {
    const passwordHash = AuthManager.#pwhash(password);
    console.log(passwordHash);

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

  /**
   * @param {string} username Username
   * @param {string} password Password
   */
  async register(username, password) {
    const db = new DatabaseConnection();
    const existingUser = db.findUser({ username });

    if (existingUser) {
      throw new UserFacingError("User already exists with this username");
    }

    await db.createUser({ username, passwordHash: AuthManager.#pwhash(password) });
    return await this.login(username, password);
  }

  /**
   * @param {string} authToken
   */
  getUser(authToken) {
    const id = this.#tokenMap.get(authToken)
    if (id) {
      const db = new DatabaseConnection()
      return db.getUser(id);
    }
  }

  /**
   * @param {string} authToken 
   */
  logout(authToken) {
    return this.#tokenMap.delete(authToken)
  }

  /**
   * Makes a hash string from a password
   * @param {string} password 
   * @returns {string} hash string
   */
  static #pwhash(password) {
    const passwordHasher = createHash("sha512")
    passwordHasher.update(password, "utf8");
    return passwordHasher.digest().reduce((prev, cur) => prev + cur.toString(16), "");
  }

  /**
   * just generates a completely random 64 byte string
   * @returns {Promise<string>} the "token" in question
   */
  static #generateToken() {
    return new Promise((resolve, reject) => {
      randomBytes(64, (err, buf) => {
        if (err) reject(err);
        const token = buf.toString("base64");
        resolve(token);
      })
    })
  }
}
