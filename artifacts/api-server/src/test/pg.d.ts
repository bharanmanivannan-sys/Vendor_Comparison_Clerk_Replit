declare module "pg" {
  const pg: {
    Pool: new (options: { connectionString: string }) => unknown;
  };
  export default pg;
}