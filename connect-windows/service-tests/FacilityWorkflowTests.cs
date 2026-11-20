public sealed class FacilityWorkflowTests
{
    [WindowsFact]
    public Task Scoped_workflow_survives_restart_and_requires_exact_tested_rules() =>
        FacilityWorkflowScenario.Run(Path.Combine(AppContext.BaseDirectory,"reference"));
}
