import { customAlphabet } from "nanoid";

const alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const generate = customAlphabet(alphabet, 8);

export function newId(taken?: ReadonlySet<string>): string {
  for (;;) {
    const id = generate();
    if (!taken?.has(id)) return id;
  }
}
