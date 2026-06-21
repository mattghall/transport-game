// Updates the S3 bucket website redirect to the given URL
import { S3Client, PutBucketWebsiteCommand } from "@aws-sdk/client-s3";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(readFileSync(join(__dirname, "transit-config.json"), "utf8"));

const s3 = new S3Client({
  region: config.aws.region,
  credentials: { accessKeyId: config.aws.accessKeyId, secretAccessKey: config.aws.secretAccessKey }
});

const tunnelUrl = process.argv[2];
if (!tunnelUrl) { console.error("Usage: node update-transit-redirect.mjs <tunnel-url>"); process.exit(1); }

const hostname = tunnelUrl.replace("https://", "").replace("http://", "");

await s3.send(new PutBucketWebsiteCommand({
  Bucket: config.bucket,
  WebsiteConfiguration: {
    RedirectAllRequestsTo: { HostName: hostname, Protocol: "https" }
  }
}));

console.log(`✓ http://${config.domain} → https://${hostname}`);
