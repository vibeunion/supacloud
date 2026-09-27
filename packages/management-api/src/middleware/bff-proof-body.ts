import { Elysia } from "elysia";
import { captureBffProofBody } from "../services/bff-proof.service";

export const bffProofBodyCapture = new Elysia({ name: "bff-proof-body-capture" })
  .request(({ request }) => captureBffProofBody(request));
