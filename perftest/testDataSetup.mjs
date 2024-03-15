import axios from "axios";
import nJwt from "njwt";
import secureRandom from "secure-random";
import Chance from "chance";
import _ from "lodash";

const chance = new Chance();

/** need to update after Blockchain restart */
const namespace =
  "1220d830f781e3cb095dfbbcca64f30347d45af2f424507b342a23496915e7e2b410";

/** test dimensions */
const n = 10;
const d = 10;
const l = 10;
const m = 1;
const t = 10;

/** this is a user who can act as any party */
const claims = {
  sub: "testUser",
  scope: "daml_ledger_api",
};
const signingKey = secureRandom(256, { type: "Buffer" });
const token = nJwt.create(claims, signingKey).compact();
const api = axios.create({
  baseURL: "http://localhost:7575",
  //   timeout: 20000,
  headers: { Authorization: `Bearer ${token}` },
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
        id: `L:${chance.string({
          alpha: true,
          length: 10,
        })}`,
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
        const dsId = `DS:${chance.string({
          alpha: true,
          length: 10,
        })}`;
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
        const dsIndexes = chance.pickset([...Array(l).keys()], t);
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
    await Promise.all(
      ds.map(async (dataset) => {
        await api
          .post("/v1/create", {
            templateId: "CRM:DatasetMeta",
            payload: dataset,
          })
          .catch((e) => console.log(e.response.data));
      })
    );
  }

  /** datasets */
  await writeDS();

  async function writeL() {
    const ls = _.flatten(_.values(licenses));
    await Promise.all(
      ls.map(async (license) => {
        await api
          .post("/v1/create", {
            templateId: "CRM:License",
            payload: license,
          })
          .catch((e) => console.log(e.response.data));
      })
    );
  }

  /** licenses */
  await writeL();

  async function writeM() {
    const ms = _.flatten(_.values(models));
    await Promise.all(
      ms.map(async (model) => {
        await api
          .post("/v1/create", {
            templateId: "CRM:ModelMeta",
            payload: model,
          })
          .catch((e) => console.log(e.response.data));
      })
    );
  }

  /** models */
  await writeM();

  // console.log(JSON.stringify(licenses, null, 2));
  // console.log(JSON.stringify(datasets, null, 2));
  // console.log(JSON.stringify(models, null, 2));
  return {
    models: _.flatten(_.values(models)),
    datasets: _.flatten(_.values(datasets)),
    licenses: _.flatten(_.values(licenses)),
  };
}

async function getModelLicenses(modelId, modelOwner) {
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
    .catch((e) => console.log(e.response.data));

  // get dataset meta
  const datasets = await Promise.all(
    model.datasetList.map(async (dId) => {
      return await api
        .post("/v1/query", {
          templateIds: ["CRM:DatasetMeta"],
          query: {
            id: dId,
          },
          readers: [modelOwner],
        })
        .then((res) => res.data.result[0].payload)
        .catch((e) => console.log(e.response.data));
    })
  );

  // get license
  await Promise.all(
    datasets.map(async (d) => {
      return await api
        .post("/v1/query", {
          templateIds: ["CRM:License"],
          query: {
            id: d.licenseId,
          },
          readers: [modelOwner],
        })
        .then((res) => res.data.result[0].payload)
        .catch((e) => console.log(e.response.data));
    })
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
    .catch((e) => console.log(e.response.data));

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
        .catch((e) => console.log(e.response.data));
    })
  );

  // get model meta
  const models = await Promise.all(
    datasets.map(async (d) => {
      return await Promise.all(
        d.modelList.map((m) =>
          api
            .post("/v1/query", {
              templateIds: ["CRM:ModelMeta"],
              query: {
                id: m,
              },
              readers: [modelOwner],
            })
            .then((res) => res.data.result[0].payload)
            .catch((e) => console.log(e.response.data))
        )
      );
    })
  );
}

async function getModelDatasets(modelId, modelOwner) {
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
    .catch((e) => console.log(e.response.data));

  // get dataset meta
  const datasets = await Promise.all(
    model.datasetList.map(async (dId) => {
      return await api
        .post("/v1/query", {
          templateIds: ["CRM:DatasetMeta"],
          query: {
            id: dId,
          },
          readers: [modelOwner],
        })
        .then((res) => res.data.result[0].payload)
        .catch((e) => console.log(e.response.data));
    })
  );
}

async function main() {
  const { models, licenses } = await setup();

  const testModels = chance.pickset(models, 10);
  const time1 = await Promise.all(
    testModels.map(async (m) => {
      var start = new Date();
      await getModelLicenses(m.id, m.modelOwner);
      var end = new Date();
      return end.getTime() - start.getTime();
    })
  );
  const average1 = _.mean(time1);
  console.log("getModelLicenses:", average1);

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
  console.log("getModelsByLicense", average2);

  const time3 = await Promise.all(
    testModels.map(async (m) => {
      var start = new Date();
      await getModelDatasets(m.id, m.modelOwner);
      var end = new Date();
      return end.getTime() - start.getTime();
    })
  );
  const average3 = _.mean(time3);
  console.log("getModelDatasets", average3);
}

main();
