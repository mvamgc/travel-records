import { App } from 'aws-cdk-lib';
import { domainFromContext } from '../lib/config';

test('a stage reads its domain and hosted zone from its own context keys', () => {
  const app = new App({ context: { prodDomainName: 'app.example.com', prodHostedZoneId: 'Z1' } });
  expect(domainFromContext(app, 'prod')).toEqual({ name: 'app.example.com', hostedZoneId: 'Z1' });
});

test('empty variables mean no domain', () => {
  const app = new App({ context: { prodDomainName: '', prodHostedZoneId: '' } });
  expect(domainFromContext(app, 'prod')).toBeUndefined();
});

test('a domain without its hosted zone ID fails synthesis', () => {
  const app = new App({ context: { prodDomainName: 'app.example.com', prodHostedZoneId: '' } });
  expect(() => domainFromContext(app, 'prod')).toThrow('prodHostedZoneId');
});

test("one stage's domain never reaches the other", () => {
  const app = new App({ context: { prodDomainName: 'app.example.com', prodHostedZoneId: 'Z1' } });
  expect(domainFromContext(app, 'dev')).toBeUndefined();
});
