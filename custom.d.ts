import { ObjectId, WithId } from "mongodb";
import { User } from "./types.js";

declare module 'express-serve-static-core' {
    export interface Request {
       user?: WithId<User>
    }
}