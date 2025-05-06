import { ObjectId } from "mongodb";

export type Topic = {
    title: string;
    lastBump: Date;
    accessCount: number;
    posts: Post[];
    subscribers: ObjectId[];
};

export type TopicWithUsers = Topic & {
    users: Omit<User, "passwordHash">[];
}

export type Post = {
    author: ObjectId;
    created: Date;
    body: string;
}

export type User = {
    username: string;
    passwordHash: string;
}