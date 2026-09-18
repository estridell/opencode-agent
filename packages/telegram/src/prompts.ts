import { createInterface } from "node:readline"
import { Writable } from "node:stream"

export class SetupCancelled extends Error {}

/** Use plain text. Hide secret input and restore terminal settings when input stops. */
export async function ask(label: string, options: {
  defaultValue?: string
  secret?: boolean
  validate?: (answer: string) => string | undefined
} = {}): Promise<string> {
  while (true) {
    const output = new Writable({
      write(chunk, _encoding, callback) {
        if (!options.secret) process.stdout.write(chunk)
        callback()
      },
    })
    const rl = createInterface({ input: process.stdin, output, terminal: !!options.secret })
    const suffix = options.defaultValue === undefined ? "" : ` [${options.defaultValue}]`
    process.stdout.write(`${label}${suffix}: `)
    let answer: string
    try {
      answer = await new Promise<string>((resolve, reject) => {
        rl.once("SIGINT", () => reject(new SetupCancelled()))
        rl.once("close", () => reject(new SetupCancelled()))
        rl.question("", resolve)
      })
    } finally {
      rl.close()
      output.end()
      if (options.secret) process.stdout.write("\n")
    }
    answer = answer.trim() || options.defaultValue || ""
    const error = options.validate?.(answer)
    if (!error) return answer
    console.log(error)
  }
}

export async function confirm(label: string, defaultValue = true): Promise<boolean> {
  const answer = await ask(`${label} (y/n)`, {
    defaultValue: defaultValue ? "y" : "n",
    validate: text => /^(y|yes|n|no)$/i.test(text) ? undefined : "Enter y or n.",
  })
  return /^(y|yes)$/i.test(answer)
}
