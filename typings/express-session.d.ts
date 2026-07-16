declare module "express-session" {
  interface SessionData {
    userid?: string;
    tempName?: string;
    email?: string;
    picture?: string;
  }
}

export {};
