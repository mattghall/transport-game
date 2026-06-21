// One-time setup: creates S3 bucket with website redirect + Route 53 record
import { S3Client, CreateBucketCommand, PutBucketWebsiteCommand, PutPublicAccessBlockCommand } from "@aws-sdk/client-s3";
import { Route53Client, ListHostedZonesCommand, ChangeResourceRecordSetsCommand } from "@aws-sdk/client-route-53";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(readFileSync(join(__dirname, "transit-config.json"), "utf8"));

const s3 = new S3Client({ region: config.aws.region, credentials: { accessKeyId: config.aws.accessKeyId, secretAccessKey: config.aws.secretAccessKey } });
const r53 = new Route53Client({ region: "us-east-1", credentials: { accessKeyId: config.aws.accessKeyId, secretAccessKey: config.aws.secretAccessKey } });

const bucket = config.bucket;
const domain = config.domain;

async function setup() {
  console.log(`Setting up ${domain}...`);

  // 1. Create S3 bucket
  console.log("Creating S3 bucket...");
  try {
    await s3.send(new CreateBucketCommand({
      Bucket: bucket,
      CreateBucketConfiguration: { LocationConstraint: config.aws.region }
    }));
    console.log("  ✓ Bucket created");
  } catch (e) {
    if (e.name === "BucketAlreadyOwnedByYou") {
      console.log("  ✓ Bucket already exists");
    } else {
      throw e;
    }
  }

  // 2. Disable public access block (needed for website hosting)
  await s3.send(new PutPublicAccessBlockCommand({
    Bucket: bucket,
    PublicAccessBlockConfiguration: { BlockPublicAcls: false, IgnorePublicAcls: false, BlockPublicPolicy: false, RestrictPublicBuckets: false }
  }));
  console.log("  ✓ Public access enabled");

  // 3. Configure website redirect (placeholder URL for now)
  await s3.send(new PutBucketWebsiteCommand({
    Bucket: bucket,
    WebsiteConfiguration: {
      RedirectAllRequestsTo: { HostName: "trailmatt.com", Protocol: "https" }
    }
  }));
  console.log("  ✓ Website redirect configured (placeholder)");

  // 4. Find hosted zone for trailmatt.com
  console.log("Finding Route 53 hosted zone...");
  const zones = await r53.send(new ListHostedZonesCommand({}));
  const zone = zones.HostedZones.find(z => z.Name === "trailmatt.com.");
  if (!zone) throw new Error("Could not find hosted zone for trailmatt.com");
  const zoneId = zone.Id.replace("/hostedzone/", "");
  console.log(`  ✓ Found zone: ${zoneId}`);

  // 5. Create Route 53 alias record → S3 website endpoint
  // S3 website hosted zone ID for us-west-2: Z3BJ6K6RIION7M
  console.log("Creating Route 53 record...");
  await r53.send(new ChangeResourceRecordSetsCommand({
    HostedZoneId: zoneId,
    ChangeBatch: {
      Changes: [{
        Action: "UPSERT",
        ResourceRecordSet: {
          Name: domain,
          Type: "A",
          AliasTarget: {
            HostedZoneId: "Z3BJ6K6RIION7M",
            DNSName: `${bucket}.s3-website-us-west-2.amazonaws.com`,
            EvaluateTargetHealth: false
          }
        }
      }]
    }
  }));
  console.log("  ✓ Route 53 record created");

  console.log(`\n✅ Setup complete! http://${domain} is now live (redirects to trailmatt.com until you start a game session).`);
}

setup().catch(e => { console.error("Setup failed:", e.message); process.exit(1); });
