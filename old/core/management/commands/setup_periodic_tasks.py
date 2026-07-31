from django.core.management.base import BaseCommand

from django_q.models import Schedule


class Command(BaseCommand):
    help = "Sets up periodic tasks for the application"

    def handle(self, *args, **options):
        # Schedule article cleanup
        task_name = "cleanup_old_articles"
        func_name = "core.services.article_service.ArticleService.delete_old_articles"

        # Check if schedule exists
        if not Schedule.objects.filter(func=func_name).exists():
            Schedule.objects.create(
                func=func_name,
                name="Cleanup Old Articles",
                schedule_type=Schedule.DAILY,
                repeats=-1,  # Forever
                kwargs={"months": 2},
            )
            self.stdout.write(self.style.SUCCESS(f"Created periodic task: {task_name}"))
        else:
            self.stdout.write(self.style.SUCCESS(f"Periodic task {task_name} already exists"))
