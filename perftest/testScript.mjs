import axios from "axios";
import nJwt from "njwt";
import secureRandom from "secure-random";
import Chance from "chance";
import _ from "lodash";
import http from "node:http";

const chance = new Chance();

/** need to update after Blockchain restart */
const namespace =
  "1220d57c61aa64c50c97a284475969e3cdf4fa5554137debb1cd73dc80cea13c2df3";

/** test dimensions */
const n = 10;
const d = 100;
const l = 10;
const m = 1;
const t = 30;

/** this is a user who can act as any party */
const claims = {
  sub: "testUser",
  scope: "daml_ledger_api",
};
const signingKey = secureRandom(256, { type: "Buffer" });
const token = nJwt.create(claims, signingKey).compact();
const api = axios.create({
  baseURL: "http://localhost:7575",
  timeout: 30000,
  headers: { Authorization: `Bearer ${token}` },
  httpAgent: new http.Agent({ keepAlive: true }),
});

async function setup() {
  async function healthcheck() {
    await api.get("/readyz").then((res) => console.log(res.data));
    await api.get("/v1/user").then((res) => console.log(res.data));
  }

  /** healthcheck */
  await healthcheck();

  /** set up the test data */
  const parties = [...Array(n).keys()].map(
    (i) => `Party${i + 1}::${namespace}`
  );

  const licenses = Object.fromEntries(
    parties.map((modelOwner) => [
      modelOwner,
      [...Array(l).keys()].map((i) => ({
        id: `L:${chance.guid()}`,
        scope: "scope",
        copyrightOwnerId: "cro",
        modelOwner,
        typeId: "tid",
        datasetList: [],
      })),
    ])
  );

  const datasets = Object.fromEntries(
    parties.map((modelOwner) => [
      modelOwner,
      [...Array(d).keys()].map((i) => {
        const dsId = `DS:${chance.guid()}`;
        const lIndex = chance.pickone([...Array(l).keys()]);
        licenses[modelOwner][lIndex].datasetList.push(dsId);
        const lId = licenses[modelOwner][lIndex].id;
        return {
          id: dsId,
          sourceUrl: "url",
          copyrightOwnerId: "cro",
          licenseId: lId,
          modelList: [],
          modelOwner,
        };
      }),
    ])
  );

  const models = Object.fromEntries(
    parties.map((modelOwner) => [
      modelOwner,
      [...Array(m).keys()].map((i) => {
        const mId = `M:${modelOwner}:${i}`;
        const dsIndexes = chance.pickset([...Array(d).keys()], t);
        dsIndexes.forEach((dsIndex) => {
          datasets[modelOwner][dsIndex].modelList.push(mId);
        });
        const dsIds = _.map(
          dsIndexes,
          (dsIndex) => datasets[modelOwner][dsIndex].id
        );
        return {
          id: mId,
          modelOwner: modelOwner,
          datasetList: dsIds,
          sourceModel: i === 0 ? undefined : `M:${modelOwner}:${i - 1}`,
          childModels: i < m - 1 ? [`M:${modelOwner}:${i + 1}`] : [],
        };
      }),
    ])
  );

  async function writeDS() {
    const ds = _.flatten(_.values(datasets));
    for (const dataset of ds) {
      await api
        .post("/v1/create", {
          templateId: "CRM:DatasetMeta",
          payload: dataset,
        })
        .catch((e) => {
          console.log(JSON.stringify(e.message));
        });
    }
  }

  /** datasets */
  await writeDS();

  async function writeL() {
    const ls = _.flatten(_.values(licenses));
    for (const license of ls) {
      await api
        .post("/v1/create", {
          templateId: "CRM:License",
          payload: license,
        })
        .catch((e) => console.log(e.message));
    }
  }

  /** licenses */
  await writeL();

  async function writeM() {
    const ms = _.flatten(_.values(models));
    for (const model of ms) {
      await api
        .post("/v1/create", {
          templateId: "CRM:ModelMeta",
          payload: model,
        })
        .catch((e) => console.log(e.message));
    }
  }

  /** models */
  await writeM();

  // console.log(JSON.stringify(licenses, null, 2));
  // console.log(JSON.stringify(datasets, null, 2));
  // console.log(JSON.stringify(models, null, 2));
  return {
    models: _.values(models),
    licenses: _.flatten(_.values(licenses)),
  };
}

async function getModelLicenses(modelId, modelOwner) {
  // base case
  if (!modelId) {
    return;
  }

  // get model meta
  const model = await api
    .post("/v1/query", {
      templateIds: ["CRM:ModelMeta"],
      query: {
        id: modelId,
      },
      readers: [modelOwner],
    })
    .then((res) => res.data.result[0].payload)
    .catch((e) => console.log(e.message));

  // get dataset meta
  const datasets = [];
  for (const dId of model.datasetList) {
    const d = await api
      .post("/v1/query", {
        templateIds: ["CRM:DatasetMeta"],
        query: {
          id: dId,
        },
        readers: [modelOwner],
      })
      .then((res) => res.data.result[0].payload)
      .catch((e) => console.log(e.message));
    datasets.push(d);
  }

  // get license
  for (const d of datasets) {
    await api
      .post("/v1/query", {
        templateIds: ["CRM:License"],
        query: {
          id: d.licenseId,
        },
        readers: [modelOwner],
      })
      .then((res) => res.data.result[0].payload)
      .catch((e) => console.log(e.message));
  }

  // recursively on source model
  await getModelLicenses(model.sourceModel, modelOwner);
}

async function getDownstreamModels(modelId, modelOwner) {
  // get model meta
  const model = await api
    .post("/v1/query", {
      templateIds: ["CRM:ModelMeta"],
      query: {
        id: modelId,
      },
      readers: [modelOwner],
    })
    .then((res) => res.data.result[0].payload)
    .catch((e) => console.log(e.message));

  // recursively on child models
  await Promise.all(
    model.childModels.map((mId) => getDownstreamModels(mId, modelOwner))
  );
}

async function getModelsByLicense(licenseId, modelOwner) {
  // get license
  const license = await api
    .post("/v1/query", {
      templateIds: ["CRM:License"],
      query: {
        id: licenseId,
      },
      readers: [modelOwner],
    })
    .then((res) => res.data.result[0].payload)
    .catch((e) => console.log(e.message));

  // get dataset meta
  const datasets = await Promise.all(
    license.datasetList.map(async (dId) => {
      return await api
        .post("/v1/query", {
          templateIds: ["CRM:DatasetMeta"],
          query: {
            id: dId,
          },
          readers: [modelOwner],
        })
        .then((res) => res.data.result[0].payload)
        .catch((e) => console.log(e.message));
    })
  );

  // get model meta
  await Promise.all(
    datasets.map(async (d) => {
      return await Promise.all(
        d.modelList.map(async (m) => {
          await api
            .post("/v1/query", {
              templateIds: ["CRM:ModelMeta"],
              query: {
                id: m,
              },
              readers: [modelOwner],
            })
            .then((res) => res.data.result[0].payload)
            .catch((e) => console.log(e.message));
          await getDownstreamModels(m, modelOwner);
        })
      );
    })
  );
}

async function getModelDatasets(modelId, modelOwner) {
  // base case
  if (!modelId) {
    return;
  }

  // get model meta
  const model = await api
    .post("/v1/query", {
      templateIds: ["CRM:ModelMeta"],
      query: {
        id: modelId,
      },
      readers: [modelOwner],
    })
    .then((res) => res.data.result[0].payload)
    .catch((e) => console.log(e.message));

  // get dataset meta
  for (const dId of model.datasetList) {
    await api
      .post("/v1/query", {
        templateIds: ["CRM:DatasetMeta"],
        query: {
          id: dId,
        },
        readers: [modelOwner],
      })
      .then((res) => res.data.result[0].payload)
      .catch((e) => console.log(e.message));
  }

  // recursively on source model
  await getModelDatasets(model.sourceModel, modelOwner);
}

function getStandardDeviation(array) {
  const n = array.length;
  const mean = array.reduce((a, b) => a + b) / n;
  return Math.sqrt(
    array.map((x) => Math.pow(x - mean, 2)).reduce((a, b) => a + b) / n
  ).toFixed(1);
}

async function main() {
  const { models, licenses } = await setup();

  const testParties = chance.pickset([...Array(n).keys()], 10);
  const testModels = testParties.map((index) => models[index][m - 1]);
  const time1 = await Promise.all(
    testModels.map(async (m) => {
      var start = new Date();
      await getModelLicenses(m.id, m.modelOwner);
      var end = new Date();
      return end.getTime() - start.getTime();
    })
  );
  const average1 = _.mean(time1);
  const std1 = getStandardDeviation(time1);
  console.log("getModelLicenses:", average1, std1);

  const testLicenses = chance.pickset(licenses, 10);
  const time2 = await Promise.all(
    testLicenses.map(async (l) => {
      var start = new Date();
      await getModelsByLicense(l.id, l.modelOwner);
      var end = new Date();
      return end.getTime() - start.getTime();
    })
  );
  const average2 = _.mean(time2);
  const std2 = getStandardDeviation(time2);
  console.log("getModelsByLicense:", average2, std2);

  const time3 = await Promise.all(
    testModels.map(async (m) => {
      var start = new Date();
      await getModelDatasets(m.id, m.modelOwner);
      var end = new Date();
      return end.getTime() - start.getTime();
    })
  );
  const average3 = _.mean(time3);
  const std3 = getStandardDeviation(time3);
  console.log("getModelDatasets:", average3, std3);
}

main();
