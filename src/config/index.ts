export const config = {
  port: parseInt(process.env.PORT ?? '3000', 10),
  actionTimeoutSeconds: parseInt(process.env.ACTION_TIMEOUT_SECONDS ?? '30', 10),
  startingChips: parseInt(process.env.STARTING_CHIPS ?? '10000', 10),
};
